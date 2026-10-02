const express = require("express");
const crypto = require("crypto");

const {
  resolveInstagramReel,
} = require("../services/saveapi");

const {
  createStagedUpload,
  uploadToStagedTarget,
  createShopifyFile,
  waitForShopifyFile,
} = require("../services/shopify");

const router = express.Router();

router.post("/reel", async (req, res) => {
  const requestId = crypto.randomUUID();

  const {
    url: instagramUrl,
  } = req.body;

  console.log(
    `[${requestId}] Reel upload request received`
  );

  // -----------------------------------------
  // 1. Validate request
  // -----------------------------------------

  if (
    !instagramUrl ||
    typeof instagramUrl !== "string"
  ) {
    return res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message:
        "Instagram Reel URL is required",
      requestId,
    });
  }

  try {
    // -----------------------------------------
    // 2. Resolve Instagram Reel using SaveAPI
    // -----------------------------------------

    console.log(
      `[${requestId}] Resolving Instagram Reel`
    );

    const resolved =
      await resolveInstagramReel(
        instagramUrl
      );

    if (!resolved?.videoUrl) {
      throw new Error(
        "SaveAPI did not return a video URL"
      );
    }

    console.log(
      `[${requestId}] Instagram Reel resolved`
    );

    console.log(
      `[${requestId}] Source video URL received`
    );

    // -----------------------------------------
    // 3. Download video from Instagram CDN
    // -----------------------------------------

    console.log(
      `[${requestId}] Downloading video`
    );

    const videoResponse =
      await fetch(
        resolved.videoUrl,
        {
          method: "GET",
          headers: {
            Accept: "video/mp4,video/*,*/*",
          },
          signal:
            AbortSignal.timeout(
              60_000
            ),
          redirect: "follow",
        }
      );

    if (!videoResponse.ok) {
      throw new Error(
        `Failed to download Instagram video: ${videoResponse.status}`
      );
    }

    // -----------------------------------------
    // IMPORTANT:
    // Do not trust Instagram's content-type.
    // Shopify should receive this as MP4.
    // -----------------------------------------

    const mimeType =
      "video/mp4";

    const contentLength =
      videoResponse.headers.get(
        "content-length"
      );

    console.log(
      `[${requestId}] Instagram response`,
      {
        contentType:
          videoResponse.headers.get(
            "content-type"
          ),
        contentLength,
      }
    );

    const arrayBuffer =
      await videoResponse.arrayBuffer();

    const videoBuffer =
      Buffer.from(arrayBuffer);

    const fileSize =
      videoBuffer.length;

    if (fileSize === 0) {
      throw new Error(
        "Downloaded video is empty"
      );
    }

    console.log(
      `[${requestId}] Video downloaded`,
      {
        fileSize,
        fileSizeMB: (
          fileSize /
          1024 /
          1024
        ).toFixed(2),
        mimeType,
      }
    );

    // -----------------------------------------
    // 4. Create Shopify staged upload
    // -----------------------------------------

    const filename =
      `instagram-reel-${Date.now()}.mp4`;

    console.log(
      `[${requestId}] Creating Shopify staged upload`,
      {
        filename,
        fileSize,
        mimeType,
      }
    );

    const stagedTarget =
      await createStagedUpload({
        filename,
        mimeType,
        fileSize,
      });

    console.log(
      `[${requestId}] Shopify staged target created`
    );

    // -----------------------------------------
    // 5. Upload MP4 to Shopify staging
    // -----------------------------------------

    console.log(
      `[${requestId}] Uploading video to Shopify staging`
    );

    await uploadToStagedTarget({
      stagedTarget,
      videoBuffer,
      filename,
      mimeType,
    });

    console.log(
      `[${requestId}] Video uploaded to Shopify staging`
    );

    // -----------------------------------------
    // 6. Create Shopify Files video
    // -----------------------------------------

    console.log(
      `[${requestId}] Creating Shopify Files video`
    );

    const shopifyFile =
      await createShopifyFile({
        resourceUrl:
          stagedTarget.resourceUrl,
        filename,
      });

    console.log(
      `[${requestId}] Shopify file created`,
      {
        fileId:
          shopifyFile.id,
        fileStatus:
          shopifyFile.fileStatus,
      }
    );

    // -----------------------------------------
    // 7. Wait for Shopify video processing
    // -----------------------------------------

    console.log(
      `[${requestId}] Waiting for Shopify video processing`
    );

    const readyFile =
      await waitForShopifyFile({
        fileId:
          shopifyFile.id,
      });

    console.log(
      `[${requestId}] Shopify video is READY`,
      {
        fileId:
          readyFile.id,
        videoUrl:
          readyFile.videoUrl,
      }
    );

    // -----------------------------------------
    // 8. Return Shopify CDN URL
    // -----------------------------------------

    return res.status(200).json({
      success: true,

      videoUrl:
        readyFile.videoUrl,

      shopifyFileId:
        readyFile.id,

      fileStatus:
        readyFile.fileStatus,

      requestId,
    });

  } catch (error) {
    // -----------------------------------------
    // Error handling
    // -----------------------------------------

    console.error(
      `[${requestId}] Reel processing failed`,
      {
        message:
          error.message,
        stack:
          error.stack,
      }
    );

    return res.status(
      error.status || 500
    ).json({
      success: false,

      error:
        error.code ||
        "REEL_PROCESSING_ERROR",

      message:
        error.message,

      requestId,
    });
  }
});

module.exports = router;
