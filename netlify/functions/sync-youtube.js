// netlify/functions/sync-youtube.js
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

export async function handler() {
  const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
  const COLLECTION_ID = process.env.COLLECTION_ID;
  const SITE_ID = process.env.SITE_ID;
  const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const parser = new XMLParser({ ignoreAttributes: false });

  try {
    // 1. Fetch RSS feed
    const rssResp = await fetch(rssUrl);
    const rssXml = await rssResp.text();
    const json = parser.parse(rssXml);
    const entries = json.feed.entry || [];

    for (let entry of entries) {
      const videoId = entry["yt:videoId"];
      const title = entry.title;
      const link = entry.link["@_href"];
      const description = entry["media:group"]["media:description"];
      const thumbnail = entry["media:group"]["media:thumbnail"]["@_url"];

      const slug = `yt-${videoId}`;

      // 2. Check if item already exists
      const checkResp = await fetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items?limit=1&slug=${slug}`,
        { headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` } }
      );
      const existing = await checkResp.json();
      if (existing.items && existing.items.length > 0) {
        console.log(`Skipping, already exists: ${title}`);
        continue;
      }

      // 3. Create CMS item
      const createResp = await fetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WEBFLOW_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            isDraft: false,
            isArchived: false,
            fields: {
              name: title,
              slug: slug,
              youtubeUrl: link,
              description: description,
              thumbnail: thumbnail,
            },
          }),
        }
      );

      if (!createResp.ok) {
        console.error("Error creating item:", await createResp.text());
        continue;
      }

      const created = await createResp.json();
      console.log("Created:", created.id);

      // 4. Publish
      await fetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WEBFLOW_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            itemIds: [created.id],
            publishToWebflow: true,
          }),
        }
      );
      console.log(`Published: ${title}`);
    }

    return { statusCode: 200, body: "Sync complete" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.toString() };
  }
}
