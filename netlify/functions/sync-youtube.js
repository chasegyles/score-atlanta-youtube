// netlify/functions/sync-youtube.js
// package.json must include: { "type": "module" }
// deps: node-fetch, fast-xml-parser

export const config = {
  schedule: "0 * * * *" // run at the top of every hour UTC
};

import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

export async function handler() {
  const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
  const COLLECTION_ID = process.env.COLLECTION_ID;
  const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;

  if (!WEBFLOW_TOKEN || !COLLECTION_ID || !CHANNEL_ID) {
    const msg =
      "Missing required env vars: WEBFLOW_API_TOKEN, COLLECTION_ID, YOUTUBE_CHANNEL_ID";
    console.error(msg);
    return { statusCode: 500, body: msg };
  }

  // --- helper: fetch existing Webflow slugs AND video URLs (pagination aware) ---
  async function getExistingSlugsAndUrls() {
    const slugs = new Set();
    const urls = new Set();

    let nextUrl = `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`;
    while (nextUrl) {
      const resp = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${WEBFLOW_TOKEN}`,
          Accept: "application/json"
        }
      });
      if (!resp.ok) {
        console.error("Error fetching existing items:", await resp.text());
        break;
      }
      const data = await resp.json();

      for (const item of data.items || []) {
        if (item.slug) slugs.add(item.slug);

        // Your field slug for the Link is "video-url"
        const vurl = item.fieldData?.["video-url"];
        if (typeof vurl === "string" && vurl.trim()) {
          urls.add(vurl.trim());
        }
      }

      // Webflow v2 returns a fully qualified URL for the next page (or null)
      nextUrl = data?.pagination?.nextPage || null;
    }

    return { slugs, urls };
  }

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

  try {
    // 1) Load existing items
    const { slugs: existingSlugs, urls: existingUrls } = await getExistingSlugsAndUrls();
    console.log(
      `Loaded ${existingSlugs.size} existing slugs and ${existingUrls.size} existing video URLs`
    );

    // 2) Fetch YouTube RSS
    const rssResp = await fetch(rssUrl);
    if (!rssResp.ok) {
      const txt = await rssResp.text();
      throw new Error(`Failed to fetch RSS (${rssResp.status}): ${txt}`);
    }
    const rssXml = await rssResp.text();
    const json = parser.parse(rssXml);

    // Normalize entries to an array
    let entries = json?.feed?.entry ?? [];
    if (!Array.isArray(entries)) entries = [entries];
    console.log(`Found ${entries.length} RSS entries`);

    for (const entry of entries) {
      if (!entry) continue;

      const videoId = entry["yt:videoId"];
      const title = entry.title;
      const link =
        entry?.link?.["@_href"] || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
      const publishedRaw = entry.published; // ISO from RSS
      const rawDescription = entry?.["media:group"]?.["media:description"] ?? "";
      const thumbUrl =
        entry?.["media:group"]?.["media:thumbnail"]?.["@_url"] ||
        (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "");

      if (!videoId || !title || !link) {
        console.log("Skipping entry with missing id/title/link");
        continue;
      }

      const slug = `yt-${videoId}`;
      const urlKey = link.trim();

      // --- HARD DEDUPE: skip if slug OR URL already exists ---
      if (existingSlugs.has(slug)) {
        console.log(`Skip (slug exists): ${slug}`);
        continue;
      }
      if (existingUrls.has(urlKey)) {
        console.log(`Skip (URL exists): ${urlKey}`);
        continue;
      }

      const publishedISO = new Date(publishedRaw).toISOString();

      // --- sanitize description for single-line field ---
      const descriptionOneLine = rawDescription
        .replace(/\r?\n|\r/g, " ") // newlines → spaces
        .replace(/\s+/g, " ") // collapse multiple spaces
        .trim();

      const MAX_LEN = 1000; // optional safety cutoff
      const safeDescription =
        descriptionOneLine.length > MAX_LEN
          ? descriptionOneLine.slice(0, MAX_LEN)
          : descriptionOneLine;

      // 3) Create CMS item
      const payload = {
        isDraft: false,
        isArchived: false,
        fieldData: {
          // Built-ins
          name: title,
          slug: slug,

          // Your exact slugs
          "video-url": urlKey,
          "description-2": safeDescription,
          "published-date": publishedISO,

          // Image field with URL
          "thumbnail-image": {
            url: thumbUrl,
            alt: title
          }
        }
      };

      const createResp = await fetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WEBFLOW_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(payload)
        }
      );

      if (!createResp.ok) {
        const errTxt = await createResp.text();
        // If Webflow decided to auto-uniquify the slug and still created the item,
        // this would have been ok(). If it's a true conflict or validation issue,
        // we log and continue.
        console.error("Error creating item:", errTxt);
        continue;
      }

      const created = await createResp.json();
      const createdId = created?.id || created?.item?.id;
      if (!createdId) {
        console.error("Create succeeded but no item id in response:", created);
        continue;
      }
      console.log(`Created item: ${createdId} (${title})`);

      // Add to our in-memory sets to avoid dupes within the same run
      existingSlugs.add(slug);
      existingUrls.add(urlKey);

      // 4) Publish
      const publishResp = await fetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WEBFLOW_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify({
            itemIds: [createdId],
            publishToWebflow: true
          })
        }
      );

      if (!publishResp.ok) {
        const pubTxt = await publishResp.text();
        console.error("Error publishing item:", pubTxt);
        continue;
      }

      console.log(`Published: ${title}`);
    }

    return { statusCode: 200, body: "Sync complete" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: String(err) };
  }
}
