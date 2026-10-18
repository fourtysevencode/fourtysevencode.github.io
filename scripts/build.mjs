// Builds the static site into dist/.
// Fetches public repos, keeps the ones with a detailed README, puts pinned repos
// first, and writes the /projects/ listing plus one crawlable page per project.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import sharp from "sharp";

const SITE = "https://ronakbuilds.tech";
const USER = "fourtysevencode";
const AUTHOR = "Ronak Pal";
const TOKEN = process.env.GITHUB_TOKEN;

// A README must have at least this much real text (badges, images,
// links and markdown symbols don't count) for the project to be listed
const MIN_README_CHARS = 600;
const MIN_README_BLOCKS = 3;

// Used only if pinned repos can't be read from GitHub or the backup service
const PINNED_FALLBACK = [
    "RakshAI",
    "what-do-i-wear-today",
    "pyprobe",
    "whats-above-me",
    "My-Data-Center",
    "prodo"
];

const ROOT = new URL("../", import.meta.url);
const SRC = new URL("src/", ROOT);
const DIST = new URL("dist/", ROOT);

const HEADERS = {
    "User-Agent": `${USER}-site-build`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
};

const monthYear = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

// Same tags as in src/index.html and src/projects.html
const ICON_TAGS = `<link rel="icon" href="/favicon.ico" sizes="32x32">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <link rel="manifest" href="/site.webmanifest">`;

/* Helpers */

const escapeHtml = (value = "") =>
    String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const jsonLd = (data) =>
    `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

const truncate = (text, max) =>
    text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;

const fill = (template, values) =>
    Object.entries(values).reduce((html, [key, value]) => html.split(`{{${key}}}`).join(value), template);

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

async function github(path) {
    const response = await fetch(`https://api.github.com${path}`, {
        headers: { Accept: "application/vnd.github+json", ...HEADERS }
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`GitHub returned ${response.status} for ${path}: ${await response.text()}`);
    }
    return response.json();
}

/* Data */

async function fetchRepos() {
    const all = [];
    for (let page = 1; ; page++) {
        const batch = await github(`/users/${USER}/repos?type=owner&sort=created&direction=desc&per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
    }
    return all.filter((repo) => !repo.private);
}

// Pinned repo names, in profile order. GitHub's GraphQL API first, then a backup service.
async function fetchPinned() {
    const isMine = (owner) => owner?.toLowerCase() === USER.toLowerCase();

    if (TOKEN) {
        try {
            const response = await fetch("https://api.github.com/graphql", {
                method: "POST",
                headers: { ...HEADERS, "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: `query ($login: String!) {
                        user(login: $login) {
                            pinnedItems(first: 6, types: REPOSITORY) {
                                nodes { ... on Repository { name owner { login } } }
                            }
                        }
                    }`,
                    variables: { login: USER }
                })
            });
            const nodes = (await response.json())?.data?.user?.pinnedItems?.nodes;
            if (Array.isArray(nodes)) {
                console.log("Pinned repos: from GitHub GraphQL");
                return nodes.filter((node) => isMine(node.owner?.login)).map((node) => node.name);
            }
        } catch {
            // Fall through to the backup service
        }
    }

    try {
        const response = await fetch(`https://pinned.berrysauce.dev/get/${USER}`, { signal: AbortSignal.timeout(10000) });
        const list = await response.json();
        if (response.ok && Array.isArray(list)) {
            console.log("Pinned repos: from pinned.berrysauce.dev");
            return list.filter((repo) => !repo.author || isMine(repo.author)).map((repo) => repo.name);
        }
    } catch {
        // Fall through to the fallback list
    }

    console.warn("Pinned repos: using PINNED_FALLBACK");
    return PINNED_FALLBACK;
}

// How much real writing a README has, ignoring badges, images, links and markup
function readmeSubstance(markdown) {
    const text = markdown
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")  // linked badges
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")               // images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")            // keep link text only
        .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "")          // reference definitions
        .replace(/<[^>]+>/g, "")                            // HTML tags
        .replace(/[#>*_`~|=-]+/g, " ");                     // markdown symbols

    const blocks = text
        .split(/\n\s*\n/)
        .map((block) => block.replace(/\s+/g, " ").trim())
        .filter((block) => block.length >= 20);

    return { blocks, chars: blocks.join(" ").length };
}

// Fix relative image and link paths so they point at the repo on GitHub
function resolveUrl(value, fileUrl, repoRoot) {
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return value;
    return value.startsWith("/")
        ? new URL(value.slice(1), repoRoot).href
        : new URL(value, fileUrl).href;
}

function renderReadme(markdown, repo, file) {
    const rawRoot = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/`;
    const blobRoot = `https://github.com/${repo.full_name}/blob/${repo.default_branch}/`;
    const aligned = ["align"];

    return sanitizeHtml(marked.parse(markdown, { gfm: true }), {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "details", "summary", "del", "input"]),
        allowedAttributes: {
            a: ["href", "title", "target", "rel"],
            img: ["src", "alt", "title", "width", "height", "align", "loading", "decoding"],
            input: ["type", "checked", "disabled"],
            p: aligned, div: aligned, h1: aligned, h2: aligned, h3: aligned, th: aligned, td: aligned
        },
        allowedSchemes: ["http", "https", "mailto"],
        transformTags: {
            img: (tagName, attribs) => ({
                tagName,
                attribs: {
                    ...attribs,
                    src: resolveUrl(attribs.src, file.download_url || rawRoot, rawRoot)
                        .replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, "https://github.com/$1/raw/"),
                    alt: attribs.alt ?? "",
                    loading: "lazy",
                    decoding: "async"
                }
            }),
            a: (tagName, attribs) => {
                const href = attribs.href ?? "";
                if (!href || href.startsWith("#")) return { tagName, attribs };
                return {
                    tagName,
                    attribs: {
                        ...attribs,
                        href: resolveUrl(href, file.html_url || blobRoot, blobRoot),
                        target: "_blank",
                        rel: "noopener noreferrer"
                    }
                };
            }
        }
    });
}

async function fetchProjects() {
    const [repos, pinned] = await Promise.all([fetchRepos(), fetchPinned()]);
    console.log(`Found ${repos.length} public repos`);

    const results = await mapLimit(repos, 6, async (repo) => {
        if (repo.size === 0) return null;

        const file = await github(`/repos/${repo.full_name}/readme`);
        if (!file?.content) {
            console.log(`  skip ${repo.name}: no README`);
            return null;
        }

        const markdown = Buffer.from(file.content, "base64").toString("utf8");
        const { blocks, chars } = readmeSubstance(markdown);
        if (chars < MIN_README_CHARS || blocks.length < MIN_README_BLOCKS) {
            console.log(`  skip ${repo.name}: README too short (${chars} chars, ${blocks.length} blocks)`);
            return null;
        }

        return {
            ...repo,
            slug: repo.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-"),
            summary: repo.description || truncate(blocks.find((block) => block.length >= 60) || blocks[0], 155),
            live: /^https?:\/\//i.test(repo.homepage || "") ? repo.homepage : null,
            readmeHtml: renderReadme(markdown, repo, file)
        };
    });

    // Pinned repos first (in profile order), then everything else newest first
    const pinRank = new Map(pinned.map((name, i) => [name.toLowerCase(), i]));
    const rankOf = (repo) => pinRank.get(repo.name.toLowerCase()) ?? Infinity;

    return results
        .filter(Boolean)
        .map((repo) => ({ ...repo, pinned: pinRank.has(repo.name.toLowerCase()) }))
        .sort((a, b) => {
            const rankA = rankOf(a);
            const rankB = rankOf(b);
            if (rankA !== rankB) return rankA - rankB;
            return new Date(b.created_at) - new Date(a.created_at);
        });
}

/* HTML */

function metaHtml(repo) {
    return [
        repo.pinned && `<span class="badge pinned">Pinned</span>`,
        `<time datetime="${repo.created_at}">Created ${monthYear.format(new Date(repo.created_at))}</time>`,
        repo.language && `<span>${escapeHtml(repo.language)}</span>`,
        repo.stargazers_count > 0 && `<span aria-label="${repo.stargazers_count} stars">★ ${repo.stargazers_count}</span>`,
        repo.fork && `<span class="badge">Fork</span>`,
        repo.archived && `<span class="badge">Archived</span>`
    ].filter(Boolean).join("\n                ");
}

function linkButtons(repo) {
    return [
        `<a class="button" href="${escapeHtml(repo.html_url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(repo.name)} on GitHub">GitHub ↗</a>`,
        repo.live && `<a class="button" href="${escapeHtml(repo.live)}" target="_blank" rel="noopener noreferrer" aria-label="Live site for ${escapeHtml(repo.name)}">Live ↗</a>`
    ].filter(Boolean).join("\n                ");
}

function cardHtml(repo) {
    const page = `${SITE}/projects/${repo.slug}/`;
    const topics = repo.topics?.length
        ? `<ul class="topics" aria-label="Topics">${repo.topics.slice(0, 6).map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`
        : "";

    return `
        <li>
            <article class="card">
                <h2 translate="no">${escapeHtml(repo.name)}</h2>
                <p class="meta">
                ${metaHtml(repo)}
                </p>
                <p class="desc${repo.description ? "" : " empty"}">${escapeHtml(repo.description || "No description yet.")}</p>
                ${topics}
                <div class="actions">
                <a class="button primary" href="${page}" aria-label="Read more about ${escapeHtml(repo.name)}">View More</a>
                ${linkButtons(repo)}
                </div>
            </article>
        </li>`;
}

function projectPageHtml(repo) {
    const url = `${SITE}/projects/${repo.slug}/`;
    const title = `${repo.name} · ${AUTHOR}`;
    const description = repo.summary || `${repo.name}, a project by ${AUTHOR}.`;

    const structuredData = jsonLd({
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "SoftwareSourceCode",
                name: repo.name,
                description,
                url,
                codeRepository: repo.html_url,
                programmingLanguage: repo.language || undefined,
                keywords: repo.topics?.length ? repo.topics.join(", ") : undefined,
                dateCreated: repo.created_at,
                dateModified: repo.pushed_at,
                author: { "@type": "Person", name: AUTHOR, url: `${SITE}/` }
            },
            {
                "@type": "BreadcrumbList",
                itemListElement: [
                    { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
                    { "@type": "ListItem", position: 2, name: "Projects", item: `${SITE}/projects/` },
                    { "@type": "ListItem", position: 3, name: repo.name, item: url }
                ]
            }
        ]
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="author" content="${AUTHOR}">
    <meta name="robots" content="index, follow">
    <meta name="theme-color" content="#1e1e1e">
    <link rel="canonical" href="${url}">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${url}">
    <meta property="og:site_name" content="${AUTHOR}">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    ${structuredData}

    ${ICON_TAGS}

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/assets/projects.css">
</head>

<body>
    <a class="skip-link" href="#main">Skip to README</a>

    <div class="page narrow">
        <header class="project-header">
            <a class="back" href="/projects/"><span aria-hidden="true">&lt;--</span>Projects</a>
            <h1 class="project-title" translate="no">${escapeHtml(repo.name)}</h1>
            <p class="meta">
                ${metaHtml(repo)}
            </p>
            <p class="intro">${escapeHtml(description)}</p>
            <div class="actions">
                ${linkButtons(repo)}
            </div>
        </header>

        <main id="main">
            <article class="markdown" id="readme-content">
${repo.readmeHtml}
            </article>
        </main>
    </div>
</body>
</html>
`;
}

function sitemapXml(projects) {
    const latest = projects.map((p) => p.pushed_at).sort().at(-1)?.slice(0, 10);
    const entries = [
        { loc: `${SITE}/` },
        { loc: `${SITE}/projects/`, lastmod: latest },
        ...projects.map((p) => ({ loc: `${SITE}/projects/${p.slug}/`, lastmod: p.pushed_at.slice(0, 10) }))
    ];

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `    <url><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
}

/* Icons */

// An .ico file is a small header followed by PNG images
function pngsToIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);

    let offset = 6 + 16 * images.length;
    const entries = images.map(({ size, data }) => {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);
        entry.writeUInt8(size >= 256 ? 0 : size, 1);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(data.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += data.length;
        return entry;
    });

    return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

// Turns src/favicon.svg into the PNG and ICO sizes browsers and phones ask for
async function writeIcons() {
    const rounded = await readFile(new URL("favicon.svg", SRC));
    // iOS rounds the corners itself, so the Apple icon is a plain square
    const square = Buffer.from(rounded.toString().replace(/\s+rx="[^"]*"/, ""));

    // Render at 2x and scale down for smooth edges (the SVG is 64 units wide)
    const png = (svg, size) =>
        sharp(svg, { density: (72 * size * 2) / 64 }).resize(size, size).png().toBuffer();

    const ico = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(rounded, size) })));

    await writeFile(new URL("favicon.ico", DIST), pngsToIco(ico));
    await writeFile(new URL("apple-touch-icon.png", DIST), await png(square, 180));
    await writeFile(new URL("icon-192.png", DIST), await png(rounded, 192));
    await writeFile(new URL("icon-512.png", DIST), await png(rounded, 512));
}

/* Build */

const projects = await fetchProjects();
console.log(`Listing ${projects.length} projects: ${projects.map((p) => p.name).join(", ")}`);

await rm(DIST, { recursive: true, force: true });
await cp(SRC, DIST, { recursive: true });
await writeIcons();

// src/projects.html is a template: the finished page goes to dist/projects/index.html (/projects/)
const template = await readFile(new URL("projects.html", SRC), "utf8");
await rm(new URL("projects.html", DIST));
await mkdir(new URL("projects/", DIST), { recursive: true });

const itemList = jsonLd({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Projects by ${AUTHOR}`,
    itemListElement: projects.map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${SITE}/projects/${p.slug}/`,
        name: p.name
    }))
});

await writeFile(new URL("projects/index.html", DIST), fill(template, {
    structured_data: itemList,
    projects: projects.map(cardHtml).join(""),
    count: projects.length
        ? `${projects.length} ${projects.length === 1 ? "project" : "projects"} · pinned first, then newest`
        : "No projects with a detailed README yet.",
    updated: longDate.format(new Date())
}));

for (const project of projects) {
    const dir = new URL(`projects/${project.slug}/`, DIST);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL("index.html", dir), projectPageHtml(project));
}

await writeFile(new URL("sitemap.xml", DIST), sitemapXml(projects));
await writeFile(new URL("robots.txt", DIST), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log("Built dist/");