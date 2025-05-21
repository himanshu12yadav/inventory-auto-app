import {
  Button,
  Page,
  Card,
  Text,
  Banner,
  Spinner,
  List,
  ProgressBar
} from "@shopify/polaris";

import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";
import { useActionData, useSubmit, useNavigation, useFetcher } from "@remix-run/react";

// Server-side state (only exists on the server)
// Using a module-level variable that only exists in Node.js
let serverState;
if (typeof process !== "undefined" && process.versions && process.versions.node) {
  if (!global.variantUpdateProgress) {
    global.variantUpdateProgress = {
      processedVariants: 0,
      totalVariants: 0,
      isProcessing: false,
      currentBatch: 0,
      errors: [],
      completedAt: null,
      summary: null
    };
  }

  if (!global.backgroundProcessing) {
    global.backgroundProcessing = {
      isRunning: false
    };
  }

  serverState = {
    variantUpdateProgress: global.variantUpdateProgress,
    backgroundProcessing: global.backgroundProcessing
  };
}

// Loader for authentication
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

// Helper for concurrency limit - server-side only
async function parallelLimit(tasks, limit) {
  const results = [];
  let i = 0;
  async function next() {
    if (i >= tasks.length) return;
    const idx = i++;
    results[idx] = await tasks[idx]();
    await next();
  }
  await Promise.all(Array(Math.min(limit, tasks.length)).fill(0).map(next));
  return results;
}

// Function to process variants in the background - server-side only
async function processVariantsInBackground(admin) {
  if (serverState.backgroundProcessing.isRunning) {
    console.log("Background processing already running, not starting a new one");
    return;
  }

  serverState.backgroundProcessing.isRunning = true;

  try {
    let hasNextPage = true;
    let cursor = null;
    let processedVariants = 0;
    let errors = [];
    let batchCount = 0;
    let totalVariants = 0;

    // Initialize progress tracker
    serverState.variantUpdateProgress = {
      processedVariants: 0,
      totalVariants: 0,
      isProcessing: true,
      currentBatch: 0,
      errors: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
      summary: null
    };

    // Configuration
    const BATCH_SIZE = 50; // Get 50 variants at a time
    const CONCURRENCY_LIMIT = 5; // Process 5 variants in parallel
    const DELAY_BETWEEN_BATCHES = 1000; // Larger delay between batches

    // First, get an estimate of total variants
    try {
      const countQuery = `
        query CountVariants {
          productVariants(first: 1) {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
            }
          }
          shop {
            productVariantsCount
          }
        }
      `;

      const countResponse = await admin.graphql(countQuery);
      const countData = await countResponse.json();

      if (countData.data?.shop?.productVariantsCount) {
        totalVariants = countData.data.shop.productVariantsCount;
        serverState.variantUpdateProgress.totalVariants = totalVariants;
        console.log(`Estimated total variants: ${totalVariants}`);
      }
    } catch (countError) {
      console.error("Error estimating total variants:", countError);
      // Continue anyway, we'll just not have a total count
    }

    while (hasNextPage) {
      batchCount++;
      serverState.variantUpdateProgress.currentBatch = batchCount;
      console.log(`Fetching batch ${batchCount}...`);

      try {
        // Step 1: Get a batch of variants
        const variantsQuery = `
          query GetVariants($cursor: String) {
            productVariants(first: ${BATCH_SIZE}, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  inventoryItem {
                    id
                  }
                }
              }
            }
          }
        `;

        const variantsResponse = await admin.graphql(variantsQuery, { variables: { cursor } });
        const variantsData = await variantsResponse.json();

        if (variantsData.errors) {
          throw new Error(variantsData.errors.map(e => e.message).join(', '));
        }

        const variants = variantsData.data.productVariants.edges.map(edge => edge.node);
        console.log(`Fetched ${variants.length} variants in batch ${batchCount}`);

        // Step 2: Process variants in parallel within the batch
        const variantPromises = variants.map(variant => {
          return async () => {
            console.log(`Processing variant: ${variant.id}`);

            try {
              // Step 2a: Get inventory levels for this variant
              console.log(`Fetching inventory levels for variant ${variant.id}...`);
              const inventoryQuery = `
                query InventoryLevels($inventoryItemId: ID!) {
                  inventoryItem(id: $inventoryItemId) {
                    inventoryLevels(first: 100) {
                      edges {
                        node {
                          quantities(names: ["available"]) {
                            quantity
                          }
                          location {
                            id
                            name
                          }
                        }
                      }
                    }
                  }
                }
              `;

              const inventoryResponse = await admin.graphql(inventoryQuery, {
                variables: { inventoryItemId: variant.inventoryItem.id }
              });
              const inventoryData = await inventoryResponse.json();

              if (inventoryData.errors) {
                throw new Error(inventoryData.errors.map(e => e.message).join(', '));
              }

              console.log(`Successfully fetched inventory levels for variant ${variant.id}`);

              // Step 2b: Format the inventory data
              const now = new Date().toISOString();
              const inventoryLevels = inventoryData.data.inventoryItem.inventoryLevels.edges.map(edge => {
                const locationGid = edge.node.location.id;
                const locationId = parseInt(locationGid.split('/').pop(), 10);

                return {
                  id: locationId,
                  name: edge.node.location.name,
                  available: edge.node.quantities[0]?.quantity || 0,
                  updatedAt: now
                };
              });

              console.log(`Formatted inventory data for variant ${variant.id} with ${inventoryLevels.length} locations`);

              // Step 2c: Update metafield for this variant
              console.log(`Updating metafield for variant ${variant.id}...`);
              const mutation = `
                mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
                  metafieldsSet(metafields: $metafields) {
                    metafields {
                      id
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }
              `;

              const metafieldResponse = await admin.graphql(mutation, {
                variables: {
                  metafields: [{
                    namespace: "custom",
                    key: "locations",
                    ownerId: variant.id,
                    type: "json",
                    value: JSON.stringify({
                      locations: inventoryLevels
                    })
                  }]
                }
              });

              const metafieldData = await metafieldResponse.json();

              if (metafieldData.errors) {
                throw new Error(metafieldData.errors.map(e => e.message).join(', '));
              }

              if (metafieldData.data?.metafieldsSet?.userErrors?.length > 0) {
                return {
                  success: false,
                  variantId: variant.id,
                  errors: metafieldData.data.metafieldsSet.userErrors,
                  type: 'userError'
                };
              } else {
                console.log(`Successfully updated metafield for variant ${variant.id}`);
                return { success: true, variantId: variant.id };
              }
            } catch (variantError) {
              return {
                success: false,
                variantId: variant.id,
                error: variantError.message,
                type: 'apiError'
              };
            }
          };
        });

        // Use the parallelLimit function to process variants with concurrency control
        const results = await parallelLimit(variantPromises, CONCURRENCY_LIMIT);

        // Process results
        results.forEach(result => {
          if (result) {
            processedVariants++;
            serverState.variantUpdateProgress.processedVariants = processedVariants;

            if (!result.success) {
              if (result.type === 'userError') {
                const errorInfo = {
                  variantId: result.variantId,
                  errors: result.errors,
                  type: 'userError'
                };
                errors.push(errorInfo);
                serverState.variantUpdateProgress.errors.push(errorInfo);
                console.warn(`User errors when updating metafield for variant ${result.variantId}:`,
                  result.errors);
              } else if (result.type === 'apiError') {
                const errorInfo = {
                  variantId: result.variantId,
                  error: result.error,
                  type: 'apiError'
                };
                errors.push(errorInfo);
                serverState.variantUpdateProgress.errors.push(errorInfo);
                console.error(`Error processing variant ${result.variantId}:`, result.error);
              }
            }
          }
        });

        // Step 3: Update pagination for next batch
        hasNextPage = variantsData.data.productVariants.pageInfo.hasNextPage;
        cursor = variantsData.data.productVariants.pageInfo.endCursor;

        // Wait before fetching the next batch
        if (hasNextPage) {
          console.log(`Waiting ${DELAY_BETWEEN_BATCHES}ms before fetching next batch...`);
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
        }

      } catch (batchError) {
        const errorInfo = {
          batch: batchCount,
          error: batchError.message,
          type: 'batchError'
        };
        errors.push(errorInfo);
        serverState.variantUpdateProgress.errors.push(errorInfo);
        console.error(`Error processing batch ${batchCount}:`, batchError);
        hasNextPage = false; // Stop processing if batch fails
      }
    }

    // Mark processing as complete
    serverState.variantUpdateProgress.isProcessing = false;
    serverState.variantUpdateProgress.completedAt = new Date().toISOString();
    serverState.variantUpdateProgress.summary = {
      success: true,
      processedVariants,
      totalVariants,
      batchCount,
      message: `Processed ${processedVariants} variants across ${batchCount} batches`
    };

    console.log("Background processing completed successfully");
    return { success: true, processedVariants, totalVariants, batchCount, errors };
  } catch (error) {
    console.error("Background processing failed:", error);

    // Mark processing as complete even on error
    if (serverState.variantUpdateProgress) {
      serverState.variantUpdateProgress.isProcessing = false;
      serverState.variantUpdateProgress.completedAt = new Date().toISOString();
      serverState.variantUpdateProgress.summary = {
        success: false,
        error: error.message,
        message: 'Failed to complete processing'
      };
    }

    return { success: false, error: error.message };
  } finally {
    serverState.backgroundProcessing.isRunning = false;
  }
}

// Optimized action for updating variant locations
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // For progress updates
  if (intent === "getProgress") {
    const progressData = serverState.variantUpdateProgress || {
      processedVariants: 0,
      totalVariants: 0,
      isProcessing: false,
      currentBatch: 0,
      errors: []
    };

    // If processing is complete and we have a summary, include it
    if (!progressData.isProcessing && progressData.completedAt && !progressData.summaryReturned) {
      progressData.summaryReturned = true;
      return json({
        ...progressData,
        actionCompleted: true,
        ...progressData.summary
      });
    }

    return json(progressData);
  }

  // For starting the process
  if (serverState.backgroundProcessing.isRunning) {
    return json({
      success: false,
      message: "Process already running. Please wait for it to complete."
    });
  }

  try {
    // Initialize progress tracker
    serverState.variantUpdateProgress = {
      processedVariants: 0,
      totalVariants: 0,
      isProcessing: true,
      currentBatch: 0,
      errors: [],
      startedAt: new Date().toISOString()
    };

    // Start the background processing - IMPORTANT: Actually execute it!
    // Don't just store the promise, but actually start the process
    processVariantsInBackground(admin).catch(error => {
      console.error("Unhandled error in background processing:", error);
      if (serverState.variantUpdateProgress) {
        serverState.variantUpdateProgress.isProcessing = false;
        serverState.variantUpdateProgress.error = error.message;
      }
    });

    // Return immediately to prevent browser timeout
    return json({
      success: true,
      message: "Processing started. You can track progress on this page.",
      isProcessing: true
    });
  } catch (error) {
    return json({
      success: false,
      error: error.message,
      message: 'Failed to start processing'
    }, { status: 500 });
  }
};


export default function Index() {
  const submit = useSubmit();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";
  const [showDetails, setShowDetails] = useState(false);
  const [progress, setProgress] = useState({
    processedVariants: 0,
    totalVariants: 0,
    isProcessing: false,
    currentBatch: 0,
    errors: []
  });

  // Use fetcher to poll for progress updates
  const progressFetcher = useFetcher();

  // Set up polling for progress updates
  useEffect(() => {
    let interval;

    if (isLoading || progress.isProcessing) {
      interval = setInterval(() => {
        progressFetcher.submit({ intent: "getProgress" }, { method: "post" });
      }, 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isLoading, progress.isProcessing, progressFetcher]);

  // Update progress when fetcher returns data
  useEffect(() => {
    if (progressFetcher.data) {
      setProgress(progressFetcher.data);

      // If we received a completed action summary through the progress fetcher
      if (progressFetcher.data.actionCompleted) {
        // We can treat this like an actionData response
        // This handles the case where the browser timed out but processing completed
      }
    }
  }, [progressFetcher.data]);

  // Update progress when action completes
  useEffect(() => {
    if (actionData) {
      if (actionData.isProcessing) {
        // Initial response when process starts
        setProgress(prev => ({
          ...prev,
          isProcessing: true,
          processedVariants: 0,
          totalVariants: 0,
          currentBatch: 0
        }));
      } else if (!isLoading) {
        // Final response when process completes (if browser didn't time out)
        setProgress({
          processedVariants: actionData.processedVariants || 0,
          totalVariants: actionData.totalVariants || 0,
          isProcessing: false,
          currentBatch: actionData.batchCount || 0,
          errors: actionData.errors || []
        });
      }
    }
  }, [actionData, isLoading]);

  const handleUpdate = () => {
    setShowDetails(false);
    setProgress({
      processedVariants: 0,
      totalVariants: 0,
      isProcessing: true,
      currentBatch: 0,
      errors: []
    });
    submit({}, { method: "POST" });
  };

  // Get errors from either actionData or progress data
  const errors = progress.errors || actionData?.errors || [];
  const userErrors = errors.filter(e => e.type === 'userError') || [];
  const apiErrors = errors.filter(e => e.type === 'apiError') || [];
  const batchErrors = errors.filter(e => e.type === 'batchError') || [];

  const progressPercentage = progress.totalVariants > 0
    ? Math.min(100, Math.round((progress.processedVariants / progress.totalVariants) * 100))
    : 0;

  // Determine what message to show based on combined state
  const statusMessage = progress.isProcessing
    ? "Processing... Please wait"
    : (actionData?.message || progress.message || "Ready to process");

  // Determine if we have a completed result to show
  const showResult = !progress.isProcessing && (actionData?.success !== undefined || progressFetcher.data?.actionCompleted);
  const resultSuccess = actionData?.success || progressFetcher.data?.success;
  const resultMessage = actionData?.message || progressFetcher.data?.message || "Operation completed";

  return (
    <Page>
      <Card sectioned>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Text variant="headingMd" as="h2">
            Update Variant Locations
          </Text>
          <Text as="p">
            This will update inventory location data for all product variants.
          </Text>

          <Button
            primary
            loading={isLoading}
            onClick={handleUpdate}
            disabled={isLoading || progress.isProcessing}
          >
            Update Variant Locations
          </Button>

          {(isLoading || progress.isProcessing) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center' }}>
              <Spinner />
              <Text as="p">{statusMessage}</Text>

              <div style={{ width: '100%' }}>
                <div style={{ marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                  <Text as="span">Progress:</Text>
                  <Text as="span">
                    {progress.processedVariants} / {progress.totalVariants > 0 ? progress.totalVariants : '?'} variants
                  </Text>
                </div>

                {progress.totalVariants > 0 && (
                  <ProgressBar progress={progressPercentage} size="small" />
                )}

                <div style={{ marginTop: '8px' }}>
                  <Text as="span">Current batch: {progress.currentBatch}</Text>
                </div>
              </div>
            </div>
          )}

          {showResult && (
            <Banner
              status={resultSuccess ? "success" : "critical"}
              title={resultSuccess ? "Success" : "Error"}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <Text as="p">{resultMessage}</Text>

                {(userErrors.length > 0 || apiErrors.length > 0 || batchErrors.length > 0) && (
                  <>
                    <Button plain onClick={() => setShowDetails(!showDetails)}>
                      {showDetails ? 'Hide details' : 'Show error details'}
                    </Button>

                    {showDetails && (
                      <Card sectioned>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                          {batchErrors.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <Text variant="headingSm" as="h3">Batch Errors</Text>
                              <List type="bullet">
                                {batchErrors.map((error, index) => (
                                  <List.Item key={index}>
                                    Batch {error.batch}: {error.error}
                                  </List.Item>
                                ))}
                              </List>
                            </div>
                          )}

                          {apiErrors.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <Text variant="headingSm" as="h3">API Errors</Text>
                              <List type="bullet">
                                {apiErrors.slice(0, 5).map((error, index) => (
                                  <List.Item key={index}>
                                    Variant {error.variantId}: {error.error}
                                  </List.Item>
                                ))}
                                {apiErrors.length > 5 && (
                                  <List.Item>
                                    ...and {apiErrors.length - 5} more errors
                                  </List.Item>
                                )}
                              </List>
                            </div>
                          )}

                          {userErrors.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <Text variant="headingSm" as="h3">Validation Errors</Text>
                              <List type="bullet">
                                {userErrors.slice(0, 5).map((error, index) => (
                                  <List.Item key={index}>
                                    Variant {error.variantId}: {error.errors.map(e => e.message).join(', ')}
                                  </List.Item>
                                ))}
                                {userErrors.length > 5 && (
                                  <List.Item>
                                    ...and {userErrors.length - 5} more errors
                                  </List.Item>
                                )}
                              </List>
                            </div>
                          )}
                        </div>
                      </Card>
                    )}
                  </>
                )}
              </div>
            </Banner>
          )}
        </div>
      </Card>
    </Page>
  );
}
