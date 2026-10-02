const SHOPIFY_SHOP =
    process.env.SHOPIFY_SHOP;

const SHOPIFY_ADMIN_ACCESS_TOKEN =
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

const SHOPIFY_API_VERSION =
    process.env.SHOPIFY_API_VERSION || "2026-10";

const SHOPIFY_GRAPHQL_URL =
    `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;


/**
 * Execute Shopify Admin GraphQL query
 */
async function shopifyGraphQL(
    query,
    variables = {}
) {
    if (!SHOPIFY_SHOP) {
        throw new Error(
            "SHOPIFY_SHOP is not configured"
        );
    }
    if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
        throw new Error(
            "SHOPIFY_ADMIN_ACCESS_TOKEN is not configured"
        );
    }

    const response = await fetch(
        SHOPIFY_GRAPHQL_URL,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token":
                    SHOPIFY_ADMIN_ACCESS_TOKEN,
            },

            body: JSON.stringify({
                query,
                variables,
            }),

            signal: AbortSignal.timeout(30_000),
        }
    );

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error(
            "Invalid response received from Shopify"
        );
    }

    if (!response.ok) {
        throw new Error(
            data?.errors?.[0]?.message ||
            `Shopify API returned ${response.status}`
        );
    }

    if (data.errors?.length) {
        throw new Error(
            data.errors
                .map((error) => error.message)
                .join(", ")
        );
    }

    return data.data;
}


/**
 * Step 1:
 * Ask Shopify for a temporary upload target.
 */
async function createStagedUpload({
    filename,
    mimeType,
    fileSize,
}) {
    const mutation = `
    mutation stagedUploadsCreate(
      $input: [StagedUploadInput!]!
    ) {
      stagedUploadsCreate(
        input: $input
      ) {
        stagedTargets {
          url
          resourceUrl

          parameters {
            name
            value
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

    const variables = {
        input: [
            {
                filename,
                mimeType,
                httpMethod: "POST",
                resource: "VIDEO",
                fileSize: String(fileSize),
            },
        ],
    };

    const data = await shopifyGraphQL(
        mutation,
        variables
    );

    const result =
        data.stagedUploadsCreate;

    if (result.userErrors?.length) {
        throw new Error(
            result.userErrors
                .map(
                    (error) =>
                        error.message
                )
                .join(", ")
        );
    }

    if (
        !result.stagedTargets?.length
    ) {
        throw new Error(
            "Shopify did not return a staged upload target"
        );
    }

    return result.stagedTargets[0];
}


/**
 * Step 2:
 * Upload actual video bytes to Shopify's
 * temporary staged upload URL.
 */
async function uploadToStagedTarget({
    stagedTarget,
    videoBuffer,
    filename,
    mimeType,
}) {
    const form =
        new FormData();

    for (
        const parameter
        of stagedTarget.parameters
    ) {
        form.append(
            parameter.name,
            parameter.value
        );
    }

    const blob = new Blob(
        [videoBuffer],
        {
            type: mimeType,
        }
    );

    form.append(
        "file",
        blob,
        filename
    );

    const response = await fetch(
        stagedTarget.url,
        {
            method: "POST",
            body: form,
            signal:
                AbortSignal.timeout(120_000),
        }
    );

    if (!response.ok) {
        const responseText =
            await response.text();

        throw new Error(
            `Shopify staged upload failed: ${response.status} ${responseText}`
        );
    }

    return true;
}


/**
 * Step 3:
 * Turn the staged resource into a
 * Shopify Files asset.
 */
async function createShopifyFile({
    resourceUrl,
    filename,
}) {
    const mutation = `
    mutation fileCreate(
      $files: [FileCreateInput!]!
    ) {
      fileCreate(
        files: $files
      ) {
        files {
          id
          fileStatus
          createdAt

          ... on Video {
            sources {
              url
              mimeType
              format
            }
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

    const variables = {
        files: [
            {
                alt: filename,
                contentType: "VIDEO",
                originalSource:
                    resourceUrl,
            },
        ],
    };

    const data =
        await shopifyGraphQL(
            mutation,
            variables
        );

    const result =
        data.fileCreate;

    if (result.userErrors?.length) {
        throw new Error(
            result.userErrors
                .map(
                    (error) =>
                        error.message
                )
                .join(", ")
        );
    }

    if (!result.files?.length) {
        throw new Error(
            "Shopify did not create the file"
        );
    }

    return result.files[0];
}


/**
 * Get the current state of a Shopify File.
 */
async function getShopifyFile(
    fileId
) {
    const query = `
    query GetFile($id: ID!) {
      node(id: $id) {
        ... on Video {
          id
          fileStatus
          createdAt

          sources {
            url
            mimeType
            format
          }
        }
      }
    }
  `;

    const data =
        await shopifyGraphQL(
            query,
            {
                id: fileId,
            }
        );

    return data.node;
}


/**
 * Shopify processes uploaded videos asynchronously.
 *
 * Wait until the file becomes READY.
 */
async function waitForShopifyFile({
    fileId,
    timeoutMs = 120_000,
    intervalMs = 3_000,
}) {
    const start =
        Date.now();

    while (
        Date.now() - start <
        timeoutMs
    ) {
        const file =
            await getShopifyFile(
                fileId
            );

        if (!file) {
            throw new Error(
                "Shopify file was not found"
            );
        }

        if (
            file.fileStatus === "READY"
        ) {
            const source =
                file.sources?.find(
                    (item) =>
                        item.url
                );

            if (!source?.url) {
                throw new Error(
                    "Shopify file is READY but no video source URL was returned"
                );
            }

            return {
                ...file,
                videoUrl:
                    source.url,
            };
        }

        if (
            file.fileStatus === "FAILED"
        ) {
            throw new Error(
                "Shopify failed to process the video"
            );
        }

        await new Promise(
            (resolve) =>
                setTimeout(
                    resolve,
                    intervalMs
                )
        );
    }

    throw new Error(
        "Timed out waiting for Shopify to process the video"
    );
}


module.exports = {
    shopifyGraphQL,
    createStagedUpload,
    uploadToStagedTarget,
    createShopifyFile,
    getShopifyFile,
    waitForShopifyFile,
};