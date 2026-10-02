const SAVEAPI_URL = "https://api.saveapi.org/v1/download";

class ResolverError extends Error {
  constructor(message, code, status = 500, retryable = false) {
    super(message);

    this.name = "ResolverError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function validateInstagramUrl(value) {
  try {
    const url = new URL(value);

    const hostname = url.hostname.toLowerCase();

    const isInstagram =
      hostname === "instagram.com" ||
      hostname === "www.instagram.com";

    if (!isInstagram) {
      throw new ResolverError(
        "Only Instagram URLs are supported",
        "INVALID_PLATFORM",
        400
      );
    }

    const isReel =
      url.pathname.startsWith("/reel/") ||
      url.pathname.startsWith("/reels/");

    if (!isReel) {
      throw new ResolverError(
        "URL must be an Instagram Reel",
        "INVALID_REEL_URL",
        400
      );
    }

    return url.toString();
  } catch (error) {
    if (error instanceof ResolverError) {
      throw error;
    }

    throw new ResolverError(
      "Invalid Instagram Reel URL",
      "INVALID_URL",
      400
    );
  }
}

async function requestSaveAPI(instagramUrl) {
  const url = new URL(SAVEAPI_URL);

  url.searchParams.set("url", instagramUrl);

  let response;

  try {
    response = await fetch(url, {
      method: "GET",

      headers: {
        Authorization: `Bearer ${process.env.SAVEAPI_KEY}`,
        Accept: "application/json",
      },

      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ResolverError(
      "SaveAPI request timed out or failed",
      "UPSTREAM_TIMEOUT",
      504,
      true
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw new ResolverError(
      "Invalid response received from SaveAPI",
      "INVALID_UPSTREAM_RESPONSE",
      502,
      true
    );
  }

  if (!response.ok || !data.success) {
    const code = data?.error?.code || "UPSTREAM_ERROR";

    const message =
      data?.error?.message ||
      "SaveAPI failed to resolve the Instagram Reel";

    if (code === "PRIVATE_CONTENT") {
      throw new ResolverError(
        message,
        code,
        403
      );
    }

    if (code === "MEDIA_NOT_FOUND") {
      throw new ResolverError(
        message,
        code,
        404
      );
    }

    if (code === "RATE_LIMITED") {
      throw new ResolverError(
        message,
        code,
        429,
        true
      );
    }

    if (code === "QUOTA_EXCEEDED") {
      throw new ResolverError(
        message,
        code,
        429
      );
    }

    throw new ResolverError(
      message,
      code,
      502,
      true
    );
  }

  return data;
}

async function resolveInstagramReel(instagramUrl) {
  const validatedUrl = validateInstagramUrl(instagramUrl);

  if (!process.env.SAVEAPI_KEY) {
    throw new ResolverError(
      "SAVEAPI_KEY is not configured",
      "CONFIGURATION_ERROR",
      500
    );
  }

  const data = await requestSaveAPI(validatedUrl);
console.log("SAVEAPI MEDIAS:", JSON.stringify(data.medias, null, 2));
 const video = data.medias?.find(
  (media) =>
    media.type === "video" &&
    media.url
);

console.log("SELECTED VIDEO:", {
  type: video?.type,
  ext: video?.ext,
  format: video?.format,
  url: video?.url,
});

  if (!video) {
    throw new ResolverError(
      "No playable video was returned by SaveAPI",
      "VIDEO_NOT_FOUND",
      404
    );
  }

  

  return {
    videoUrl: video.url,
  };
}

module.exports = {
  resolveInstagramReel,
};