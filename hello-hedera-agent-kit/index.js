// index.js
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { AgentMode } from '@hashgraph/hedera-agent-kit';
import { allCorePlugins } from '@hashgraph/hedera-agent-kit/plugins';
import { HederaAIToolkit } from '@hashgraph/hedera-agent-kit-ai-sdk';
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs, wrapLanguageModel } from 'ai';
import 'dotenv/config';

const client = Client.forTestnet().setOperator(
  process.env.HEDERA_ACCOUNT_ID,
  PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY),
  // PrivateKey.fromStringED25519(process.env.PRIVATE_KEY), // use this instead for ED25519 keys
);

const toolkit = new HederaAIToolkit({
  client,
  configuration: {
    tools: [],
    plugins: allCorePlugins,
    context: { mode: AgentMode.AUTONOMOUS },
  },
});

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: toolkit.middleware(),
});

const response = await generateText({
  model,
  messages: [{ role: 'user', content: "what's my balance?" }],
  tools: toolkit.getTools(),
  stopWhen: stepCountIs(2),
});

console.log(response.text);
