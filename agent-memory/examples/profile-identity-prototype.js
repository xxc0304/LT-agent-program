import { resolveOpenClawProfilePrincipal } from "../src/profile-identity.js";

// Synthetic-only fixture. This map is deliberately local and must never be
// replaced with production sender IDs or treated as an authentication service.
const syntheticMappings = new Map([
  ["feishu|lab|synthetic-sender-owner", {
    active: true,
    profile_id: "profile_demo_owner",
    home_id: "home_demo_01",
  }],
  ["feishu|lab|synthetic-sender-member", {
    active: true,
    profile_id: "profile_demo_member",
    home_id: "home_demo_01",
  }],
]);

const resolveSyntheticIdentity = async ({ channel_id, channel_account_id, sender_id }) =>
  syntheticMappings.get(`${channel_id}|${channel_account_id}|${sender_id}`) ?? null;

const requesterContexts = [
  {
    label: "owner",
    toolContext: {
      messageChannel: "feishu",
      deliveryContext: { channel: "feishu", accountId: "lab" },
      requesterSenderId: "synthetic-sender-owner",
    },
  },
  {
    label: "member",
    toolContext: {
      messageChannel: "feishu",
      deliveryContext: { channel: "feishu", accountId: "lab" },
      requesterSenderId: "synthetic-sender-member",
    },
  },
];

for (const { label, toolContext } of requesterContexts) {
  const principal = await resolveOpenClawProfilePrincipal(toolContext, resolveSyntheticIdentity);
  console.log(`${label}: ${JSON.stringify(principal)}`);
}

try {
  await resolveOpenClawProfilePrincipal({ messageChannel: "feishu" }, resolveSyntheticIdentity);
} catch (error) {
  console.log(`missing-context: ${error.code}`);
}

try {
  await resolveOpenClawProfilePrincipal({
    messageChannel: "feishu",
    deliveryContext: { channel: "feishu", accountId: "lab" },
    requesterSenderId: "synthetic-unknown",
  }, resolveSyntheticIdentity);
} catch (error) {
  console.log(`unmapped-sender: ${error.code}`);
}
