import dotenv from "dotenv";
dotenv.config();

import { HederaElizaOSToolkit } from "@hashgraph/hedera-agent-kit-elizaos";
import { AgentMode } from "@hashgraph/hedera-agent-kit";
import {
  coreAccountPlugin,
  coreTokenPlugin,
  coreConsensusPlugin
} from "@hashgraph/hedera-agent-kit/plugins";

import {
  Client,
  PrivateKey,
  AccountCreateTransaction,
  Hbar
} from "@hashgraph/sdk";

// Load environment variables
const network = process.env.HEDERA_NETWORK || "mainnet";
const accountId = process.env.HEDERA_ACCOUNT_ID;
const privateKey = process.env.HEDERA_PRIVATE_KEY;

if (!accountId || !privateKey) {
  throw new Error("Please set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY in your .env file");
}

// Create Hedera client for mainnet

const client = Client.forName(network);
client.setOperator(accountId, privateKey);

const hederaElizaToolkit = new HederaElizaOSToolkit({
  client,
  configuration: {
    plugins: [coreAccountPlugin, coreTokenPlugin, coreConsensusPlugin],
    context: { mode: AgentMode.AUTONOMOUS }
  }
});

const hederaElizaActions = hederaElizaToolkit.getTools();

console.log("Hedera client configured for:", network);
console.log("Hedera ElizaOS actions registered:", hederaElizaActions.length);

export { client, hederaElizaToolkit, hederaElizaActions };
