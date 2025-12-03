import { authenticate } from "../shopify.server.js";

export async function action({ request }) {
  try {
    const requestClone = request.clone();
    const payload = await requestClone.json();
    console.log("Received webhook payload:", payload);

    const { admin, topic } = await authenticate.webhook(request);
    console.log("topic: ", topic);

      if (!admin) {
    console.error("Missing admin session. The shop may need to re-authenticate.");
    console.error("This error often occurs if the server (hosted on client infrastructure) restarted and the local database was wiped.");
    return new Response("Unauthorized", { status: 401 });
  }

    if (topic === "INVENTORY_LEVELS_UPDATE") {
      console.log("Processing inventory update");
      await handleInventoryUpdate(admin, payload);
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("Webhook processing failed:", error);
    return new Response("Error processing webhook", { status: 500 });
  }
}

async function handleInventoryUpdate(admin, payload) {
  const { inventory_item_id, location_id, available } = payload;




  // Step 1: Get variant and metafield

  const variantQuery = `
    query GetVariantWithMetafield($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        variant {
          id
          metafield(namespace: "custom", key: "locations") {
            id
            value
          }
        }
      }
    }
  `;

  const variantRes = await admin.graphql(variantQuery, {
    variables: {
      inventoryItemId: `gid://shopify/InventoryItem/${inventory_item_id}`,
    },
  });

  const variantJson = await variantRes.json();
  const variant = variantJson.data?.inventoryItem?.variant;

  if (!variant) {
    console.error("Variant not found for inventory item:", inventory_item_id);
    throw new Error("Variant not found");
  }

  // check if metafield is empty
  const metafieldsEmpty = !variant.metafield || !variant.metafield.value;

  let currentData;
  let allLocations = [];

  if (metafieldsEmpty) {
    console.log("Metafield is empty, fetching all inventory data for variant.");

    // Fetch all inventory levels for this variant;
    const inventoryQuery = `
      query InventoryLevels($inventoryItemId: ID!){
        inventoryItem(id:$inventoryItemId){
          inventoryLevels(first:100){
            edges{
              node{
                quantities(names:["available"]){
                  quantity
                }
                location{
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
      variables: {
        inventoryItemId: `gid://shopify/InventoryItem/${inventory_item_id}`,
      }
    });

    const inventoryData = await inventoryResponse.json();

    console.log("Inventory: ", inventoryData.data.inventoryItem.inventoryLevels.edges[0].node);
    console.log("Inventory: ", inventoryData.data.inventoryItem.inventoryLevels.edges[1].node);

    if (inventoryData.errors) {
      console.error("Error fetching inventory levels:", inventoryData.errors);
      throw new Error("Failed to fetch inventory levels.");
    }

    // Format the inventory data

    const now = new Date().toISOString();
    allLocations = inventoryData.data.inventoryItem.inventoryLevels.edges.map(edge => {
      const locationGid = edge.node.location.id;
      const locationId = parseInt(locationGid.split('/').pop(), 10);

      const availableQuantity = edge.node.quantities[0].quantity || 0;

      return {
        id: locationId,
        name: edge.node.location.name,
        available: availableQuantity,
        updatedAt: now
      };
    });

    currentData = { locations: allLocations }

    console.log(`Fetched ${allLocations.length} locations for variable`);

  } else {
    currentData = variant.metafield?.value ? JSON.parse(variant.metafield.value) : { locations: [] }
  }

  if (!metafieldsEmpty || allLocations.length === 0) {


    // Step 2: Get location name
    const locationQuery = `
    query GetLocationName($id: ID!) {
      location(id: $id) {
        id
        name
      }
    }
  `;

    const locationRes = await admin.graphql(locationQuery, {
      variables: { id: `gid://shopify/Location/${location_id}` },
    });

    const locationJson = await locationRes.json();
    const location = locationJson.data?.location;

    // Step 3: Parse and update metafield data
    // const currentData = variant.metafield?.value
    //   ? JSON.parse(variant.metafield.value)
    //   : { locations: [] };

    const index = currentData.locations.findIndex(
      (loc) => loc.id === location_id
    );

    const updatedLocation = {
      id: parseInt(location_id),
      name: location?.name || `Location ${location_id}`,
      available: parseInt(available, 10) || 0,
      updatedAt: new Date().toISOString(),
    };

    if (index >= 0) {
      currentData.locations[index] = updatedLocation;
    } else {
      currentData.locations.push(updatedLocation);
    }

  }
  // Step 4: Update metafield
  const updateMutation = `
   mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields {
      id
      key
      namespace
      value
    }
    userErrors {
      field
      message
    }
  }
}
  `;

  const updateRes = await admin.graphql(updateMutation, {
    variables: {
      metafields: [
        {
          ownerId: variant.id, // must be a valid GID, e.g., "gid://shopify/ProductVariant/123456"
          namespace: "custom",
          key: "locations",
          type: "json",
          value: JSON.stringify(currentData),
        },
      ],
    },
  });

  const updateJson = await updateRes.json();
  if (
    updateJson.errors ||
    updateJson.data?.metafieldSet?.userErrors?.length > 0
  ) {
    console.error(
      "Metafield update failed:",
      updateJson.errors || updateJson.data.metafieldSet.userErrors
    );
    throw new Error("Failed to update metafield");
  }

  console.log("Successfully updated inventory metafield for variant", variant.id);
}
