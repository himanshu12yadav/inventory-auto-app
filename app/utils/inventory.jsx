export async function getAllVariantsWithInventory(admin){
  let allVariants = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage){
    const query = `query GetVariantsWithInventory($cursor: String){
        productVariants(first:100, after:$cursor){
          pageInfo{
            hasNextPage
            endCursor
          }
          edges{
            node{
              id
              inventoryItem{
                id
                inventoryLevels(first:10){
                  edges{
                    node{
                      location {
                        id
                        name
                      }
                      available
                    }
                  }
                }
              }
              metafield(namespace:"custom", key:"locations"){
                id
                value
              }
            }
          }
        }
    }`;

    const response = await admin.graphql(query, {cursor})
    const data = await response.json();

    allVariants = [
      ...allVariants,
      ...data.data.productVariants.edges.map(edge => edge.node)
    ]

    hasNextPage = data.data.productVariants.pageInfo.hasNextPage;
    cursor = data.data.productVariants.pageInfo.endCursor;
  }

  return allVariants;
}


export async function bulkInventoryMetafields(admin){
  const variants = await getAllVariantsWithInventory(admin);

  for (let variant of variants){
    if (!variant.inventoryItem) continue;
    const inventoryLevels = variant.inventoryItem.inventoryLevels.edges.map(edge => edge.node);

    const inventoryData = {
      locations:inventoryLevels.map(level => ({
        id:level.location.id,
        name:level.location.name,
        available:level.available,
        updatedAt:new Date().toISOString()
      }))
    }

    await admin.graphql(`
      mutation UpdateMetafield($input:MetafieldInput!){
        metafieldSet(input: $input){
          metafield { id }
          userErrors{ field message }
        }
      }
    `,
      {
        variables:{
          input:{
            ownerId: variant.id,
            namespace: "custom",
            key: "locations",
            type: "json",
            value: JSON.stringify(inventoryData)
          }
        }
      })
  }

}

// export async function updateVariantMetafield(shop, inventoryItemId, locationId, newQuantity) {
//   const admin = await shopify.api.admin.createClient(shop);
//
//   // Step 1: Get the variant using inventoryItemId
//   const variantRes = await admin.graphql(`
//     query {
//       productVariants(first: 1, query: "inventory_item_id:${inventoryItemId}") {
//         edges {
//           node {
//             id
//             title
//             metafield(namespace: "custom", key: "locations") {
//               id
//               value
//             }
//           }
//         }
//       }
//     }
//   `);
//
//   const variantData = await variantRes.json();
//   const variant = variantData.data.productVariants.edges[0]?.node;
//
//   if (!variant) return;
//
//   let updatedLocations = [];
//
//   try {
//     const existing = variant.metafield?.value
//       ? JSON.parse(variant.metafield.value)
//       : { locations: [] };
//
//     updatedLocations = existing.locations.map(loc =>
//       loc.location === locationId ? { ...loc, quantity: newQuantity } : loc
//     );
//
//     const found = updatedLocations.find(loc => loc.location === locationId);
//     if (!found) {
//       updatedLocations.push({ location: locationId, quantity: newQuantity });
//     }
//
//   } catch (e) {
//     updatedLocations = [{ location: locationId, quantity: newQuantity }];
//   }
//
//   // Step 2: Update metafield
//   await admin.graphql(
//     `
//     mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
//       metafieldsSet(metafields: $metafields) {
//         metafields {
//           id
//           key
//           value
//         }
//         userErrors {
//           field
//           message
//         }
//       }
//     }
//     `,
//     {
//       variables: {
//         metafields: [
//           {
//             ownerId: variant.id,
//             namespace: "custom",
//             key: "locations",
//             type: "json",
//             value: JSON.stringify({ locations: updatedLocations })
//           }
//         ]
//       }
//     }
//   );
// }
