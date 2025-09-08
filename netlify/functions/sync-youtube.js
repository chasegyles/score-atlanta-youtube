// netlify/functions/sync-youtube.js
// package.json must include: { "type": "module" }
// deps: node-fetch, fast-xml-parser

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

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

  try {
    // 1) Fetch YouTube RSS
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
        entry?.link?.["@_href"] || `https://www.youtube.com/watch?v=${videoId}`;
      const publishedRaw = entry.published; // ISO from RSS
      const description = entry?.["media:group"]?.["media:description"] ?? "";
      const thumbUrl =
        entry?.["media:group"]?.["media:thumbnail"]?.["@_url"] ??
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      if (!videoId || !title) {
        console.log("Skipping entry with missing id/title");
        continue;
      }

      const slug = `yt-${videoId}`;
      const publishedISO = new Date(publishedRaw).toISOString();

      // 2) Create CMS item (Webflow v2 uses fieldData)
      const payload = {
        isDraft: false,
        isArchived: false,
        fieldData: {
          // Built-ins
          name: title,
          slug: slug,

          // Your exact slugs (from your schema dump)
          "video-url": link,               // Link
          "description-2": description,    // PlainText
          "published-date": publishedISO,  // DateTime

          // Image field — can accept a public URL directly (plus optional alt)
          // Ref: Field Types & Item Values → ImageRef / Image (v2)
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

      if (createResp.status === 409) {
        // Duplicate slug – already created earlier
        console.log(`Duplicate slug, skipping: ${slug}`);
        continue;
      }

      if (!createResp.ok) {
        const errTxt = await createResp.text();
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

      // 3) Publish the item
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
