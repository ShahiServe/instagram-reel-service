const express = require("express");
const crypto = require("crypto");

const { resolveInstagramReel } = require("../services/saveapi");
const { parseInstagramReelUrl } = require("../utils/instagram");

const {
  createStagedUpload,
  uploadToStagedTarget,
  createShopifyFile,
  findShopifyVideoByFilename,
  waitForShopifyFile,
  getReelsMetafield,
  saveReelToMetafield,
} = require("../services/shopify");

const router = express.Router();

// In-flight jobs only (de-dupes simultaneous requests for the same reel).
// Entries are removed as soon as a job settles; the metafield is the
// permanent cache.
const uploadJobs = new Map();

/**
 * Add the uploaded file to the custom.testimonial_reels metafield.
 * Never fails the request: the file already exists in Shopify.
 */
async function persistReel(fileId) {
  if (!fileId) {
    return;
  }

  try {
    await saveReelToMetafield(fileId);
  } catch (error) {
    console.error("Reel metafield save failed", error.message);
  }
}

router.post("/reel", async (req, res) => {
  const requestId = crypto.randomUUID();

  const { url: instagramUrl } = req.body;

  console.log(`[${requestId}] Reel upload request received`);

  // -----------------------------------------
  // 1. Validate request
  // -----------------------------------------

  if (!instagramUrl || typeof instagramUrl !== "string") {
    return res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: "Instagram Reel URL is required",
      requestId,
    });
  }

  const parsed = parseInstagramReelUrl(instagramUrl);

  if (!parsed) {
    return res.status(400).json({
      success: false,
      error: "INVALID_REEL_URL",
      message:
        "Use a public Instagram reel URL, e.g. https://www.instagram.com/reel/CODE/",
      requestId,
    });
  }

  const { code, canonicalUrl } = parsed;

  const filename = `instagram-reel-${code}.mp4`;

  if (uploadJobs.has(filename)) {
    try {
      const result = await uploadJobs.get(filename);

      return res.status(200).json({
        ...result,
        requestId,
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.code || "REEL_PROCESSING_ERROR",
        message: error.message,
        requestId,
      });
    }
  }

  let resolveJob;
  let rejectJob;

  const job = new Promise((resolve, reject) => {
    resolveJob = resolve;
    rejectJob = reject;
  });

  // Prevent an unhandled rejection when nobody else is waiting on this job
  job.catch(() => {});

  uploadJobs.set(filename, job);

  function finish(payload) {
    resolveJob(payload);
    uploadJobs.delete(filename);

    return res.status(200).json(payload);
  }

  try {
    // -----------------------------------------
    // 2. Cheapest check: already in the metafield?
    // -----------------------------------------

    if (code) {
      try {
        const { videos } = await getReelsMetafield();

        const saved = videos.find(
          (video) =>
            video.filename === filename && video.fileStatus === "READY"
        );

        const savedUrl = saved?.sources?.find(
          (item) =>
            item.url &&
            (item.mimeType === "video/mp4" || item.format === "mp4")
        )?.url;

        if (savedUrl) {
          console.log(`[${requestId}] Reel found in metafield`);

          return finish({
            success: true,
            videoUrl: savedUrl,
            shopifyFileId: saved.id,
            fileStatus: "READY",
            requestId,
          });
        }
      } catch (metafieldError) {
        console.error(
          `[${requestId}] Metafield lookup failed`,
          metafieldError.message
        );
      }
    }

    // -----------------------------------------
    // 3. Already uploaded to Shopify Files?
    //    (backfills reels uploaded before the metafield existed)
    // -----------------------------------------

    let existing = null;

    try {
      existing = await findShopifyVideoByFilename(filename);
    } catch (lookupError) {
      console.error(
        `[${requestId}] Existing reel lookup failed`,
        lookupError.message
      );
    }

    if (existing && existing.fileStatus !== "FAILED") {
      let videoUrl = null;

      if (existing.fileStatus === "READY") {
        videoUrl = existing.sources?.find(
          (item) =>
            item.url &&
            (item.mimeType === "video/mp4" || item.format === "mp4")
        )?.url;
      }

      if (!videoUrl) {
        const readyFile = await waitForShopifyFile({
          fileId: existing.id,
        });

        videoUrl = readyFile.videoUrl;
      }

      await persistReel(existing.id);

      return finish({
        success: true,
        videoUrl,
        shopifyFileId: existing.id,
        fileStatus: "READY",
        requestId,
      });
    }

    // -----------------------------------------
    // 4. Resolve Instagram Reel using SaveAPI
    // -----------------------------------------

    console.log(`[${requestId}] Resolving Instagram Reel`);

    const resolved = await resolveInstagramReel(canonicalUrl);

    if (!resolved?.videoUrl) {
      throw new Error("SaveAPI did not return a video URL");
    }

    console.log(`[${requestId}] Instagram Reel resolved`);

    // -----------------------------------------
    // 5. Download video from Instagram CDN
    // -----------------------------------------

    console.log(`[${requestId}] Downloading video`);

    const videoResponse = await fetch(resolved.videoUrl, {
      method: "GET",
      headers: {
        Accept: "video/mp4,video/*,*/*",
      },
      signal: AbortSignal.timeout(60_000),
      redirect: "follow",
    });

    if (!videoResponse.ok) {
      throw new Error(
        `Failed to download Instagram video: ${videoResponse.status}`
      );
    }

    // Do not trust Instagram's content-type. Shopify should receive MP4.
    const mimeType = "video/mp4";

    const arrayBuffer = await videoResponse.arrayBuffer();

    const videoBuffer = Buffer.from(arrayBuffer);

    const fileSize = videoBuffer.length;

    if (fileSize === 0) {
      throw new Error("Downloaded video is empty");
    }

    console.log(`[${requestId}] Video downloaded`, {
      fileSize,
      fileSizeMB: (fileSize / 1024 / 1024).toFixed(2),
      mimeType,
    });

    // -----------------------------------------
    // 6. Create Shopify staged upload
    // -----------------------------------------

    const stagedTarget = await createStagedUpload({
      filename,
      mimeType,
      fileSize,
    });

    console.log(`[${requestId}] Shopify staged target created`);

    // -----------------------------------------
    // 7. Upload MP4 to Shopify staging
    // -----------------------------------------

    await uploadToStagedTarget({
      stagedTarget,
      videoBuffer,
      filename,
      mimeType,
    });

    console.log(`[${requestId}] Video uploaded to Shopify staging`);

    // -----------------------------------------
    // 8. Create Shopify Files video
    // -----------------------------------------

    const shopifyFile = await createShopifyFile({
      resourceUrl: stagedTarget.resourceUrl,
      filename,
    });

    console.log(`[${requestId}] Shopify file created`, {
      fileId: shopifyFile.id,
      fileStatus: shopifyFile.fileStatus,
    });

    // -----------------------------------------
    // 9. Wait for Shopify video processing
    // -----------------------------------------

    const readyFile = await waitForShopifyFile({
      fileId: shopifyFile.id,
    });

    console.log(`[${requestId}] Shopify video is READY`, {
      fileId: readyFile.id,
      videoUrl: readyFile.videoUrl,
    });

    // -----------------------------------------
    // 10. Save CDN url to the metafield
    // -----------------------------------------

    await persistReel(readyFile.id);

    // -----------------------------------------
    // 11. Return Shopify CDN URL
    // -----------------------------------------

    return finish({
      success: true,
      videoUrl: readyFile.videoUrl,
      shopifyFileId: readyFile.id,
      fileStatus: readyFile.fileStatus,
      requestId,
    });
  } catch (error) {
    console.error(`[${requestId}] Reel processing failed`, {
      message: error.message,
      stack: error.stack,
    });

    uploadJobs.delete(filename);
    rejectJob(error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.code || "REEL_PROCESSING_ERROR",
      message: error.message,
      requestId,
    });
  }
});

module.exports = router;
