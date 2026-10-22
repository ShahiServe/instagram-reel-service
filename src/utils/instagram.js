/**
 * Parse any public Instagram reel URL and return its shortcode plus a
 * canonical URL.
 *
 * Accepted examples:
 *   https://www.instagram.com/reel/CgW3Wzajulj/
 *   https://www.instagram.com/non.veg.food/reel/CgW3Wzajulj/
 *   https://instagram.com/reels/CgW3Wzajulj/?igsh=abc
 *   http://m.instagram.com/someuser/reel/CgW3Wzajulj
 *   www.instagram.com/reel/CgW3Wzajulj/   (protocol missing)
 *
 * Returns null when the value is not a reel URL.
 */
function parseInstagramReelUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  let raw = value.trim();

  if (!raw) {
    return null;
  }

  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");

  if (host !== "instagram.com") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);

  const markerIndex = segments.findIndex((segment) =>
    ["reel", "reels"].includes(segment.toLowerCase())
  );

  if (markerIndex === -1) {
    return null;
  }

  const code = segments[markerIndex + 1];

  // Shortcodes are case-sensitive: never change their case
  if (!code || !/^[A-Za-z0-9_-]{5,}$/.test(code)) {
    return null;
  }

  return {
    code,
    canonicalUrl: `https://www.instagram.com/reel/${code}/`,
  };
}

module.exports = {
  parseInstagramReelUrl,
};
