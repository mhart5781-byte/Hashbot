import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs, wrapLanguageModel } from 'ai';
import { AgentMode } from '@hashgraph/hedera-agent-kit';
import { HederaAIToolkit } from '@hashgraph/hedera-agent-kit-ai-sdk';
import { memejobPlugin } from '@buidlerlabs/hak-memejob-plugin';
import { Client, PrivateKey, TransferTransaction, Hbar } from '@hiero-ledger/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.join(__dirname, '.env');
const helloAgentEnvPath = path.join(__dirname, 'hello-hedera-agent-kit', '.env');
const DEFAULT_HASHCONNECT_PROJECT_ID = '532ad873d6cccfb126b030d598b802ae';

if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath, override: false });
}
if (fs.existsSync(helloAgentEnvPath)) {
  dotenv.config({ path: helloAgentEnvPath, override: false });
}

// If root .env defines HASHCONNECT_PROJECT_ID as empty, recover it from hello-hedera-agent-kit/.env.
if (!process.env.HASHCONNECT_PROJECT_ID && fs.existsSync(helloAgentEnvPath)) {
  const parsedHelloEnv = dotenv.parse(fs.readFileSync(helloAgentEnvPath));
  if (parsedHelloEnv.HASHCONNECT_PROJECT_ID) {
    process.env.HASHCONNECT_PROJECT_ID = parsedHelloEnv.HASHCONNECT_PROJECT_ID;
  }
}

if (!process.env.HASHCONNECT_PROJECT_ID) {
  process.env.HASHCONNECT_PROJECT_ID = DEFAULT_HASHCONNECT_PROJECT_ID;
}

const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const hasHederaOperator = Boolean(process.env.HEDERA_ACCOUNT_ID && process.env.HEDERA_PRIVATE_KEY);

function normalizeNetworkType(raw) {
  return String(raw || '').toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
}

function parseSupportedNetworkTypes(raw) {
  if (!raw) {
    return ['mainnet', 'testnet'];
  }

  const normalized = Array.from(new Set(
    String(raw)
      .split(',')
      .map((item) => normalizeNetworkType(item.trim()))
      .filter(Boolean),
  ));

  return normalized.length > 0 ? normalized : ['mainnet', 'testnet'];
}

const configuredNetworkType = normalizeNetworkType(process.env.HEDERA_NETWORK || 'mainnet');
const supportedNetworkTypes = parseSupportedNetworkTypes(process.env.HEDERA_SUPPORTED_NETWORKS || 'mainnet,testnet');
if (!supportedNetworkTypes.includes(configuredNetworkType)) {
  supportedNetworkTypes.unshift(configuredNetworkType);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

const baseModel = hasOpenAIKey ? openai('gpt-4o') : null;

const operatorClient = hasHederaOperator
  ? Client.forName(configuredNetworkType).setOperator(
    process.env.HEDERA_ACCOUNT_ID,
    PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY),
  )
  : null;

const memejobToolkit = operatorClient
  ? new HederaAIToolkit({
    client: operatorClient,
    configuration: {
      tools: [],
      plugins: [memejobPlugin],
      context: { mode: AgentMode.AUTONOMOUS },
    },
  })
  : null;

const memejobToolModel = baseModel && memejobToolkit
  ? wrapLanguageModel({
    model: baseModel,
    middleware: memejobToolkit.middleware(),
  })
  : null;

const MAX_HISTORY_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 700;

const BASE_SYSTEM_PROMPT =
  'You are a Hedera expert assistant. Answer clearly and concisely with practical, developer-friendly guidance.';

const EXECUTION_PROMPT =
  `${BASE_SYSTEM_PROMPT} HBAR transfers and wallet balance checks are executable in this chat. For NFT and memecoin purchase requests, always use the already connected wallet context from the browser session and never ask the user for a wallet address. For HTS token market-cap, price, liquidity, or ranking questions, do not tell the user to check external websites. If live data is unavailable in the app, say that directly instead of redirecting elsewhere.`;

const ACTION_INTENT_REGEX = /\b(send|transfer|pay|balance|wallet|account\s+balance|check\s+balance)\b/i;
const TRANSFER_INTENT_REGEX = /\b(send|transfer|pay)\b.*\bhbar\b/i;
const BALANCE_INTENT_REGEX = /\b(balance|wallet\s+balance|account\s+balance|check\s+balance)\b/i;
const MY_BALANCE_INTENT_REGEX = /\b(my|mine)\b.*\b(hbar\s+)?balance\b|\b(hbar\s+)?balance\b.*\b(my|mine)\b/i;
const SENTX_INTENT_REGEX = /\b(sentx|nft\s+on\s+sentx|sentx\s+nfts?|sentx\s+collections?|sentx\s+volume|sentx\s+sales?)\b/i;
const MEMEJOB_INTENT_REGEX = /\b(memejob|memejob\.fun|memecoins?|meme\s+coins?|tokens?\s+on\s+memejob)\b/i;
const SAUCERSWAP_INTENT_REGEX = /\b(saucerswap|saucer\s*swap|sauce|dex\s+tokens|saucerswap\s+tokens?)\b/i;
const HTS_MARKET_CAP_INTENT_REGEX = /\b(market\s*caps?|marketcaps?|fully\s+diluted\s+value|fdv|token\s*caps?|market\s+value|largest\s+tokens?|top\s+hts\s+tokens?)\b/i;
const BONZO_INTENT_REGEX = /\b(bonzo|bonzo\s+finance|bonzo\s+lend|bonzo\s+api|lending\s+pools?\s+on\s+bonzo|debtors?\s+on\s+bonzo)\b/i;
const MEMEJOB_MARKET_ACTION_INTENT_REGEX = /\b(memejob|memejob\.fun|memecoin|memecoins)\b.*\b(create|launch|buy|purchase|sell|trade)\b|\b(create|launch|buy|purchase|sell|trade)\b.*\b(memejob|memejob\.fun|memecoin|memecoins)\b/i;
const NFT_MARKET_ACTION_INTENT_REGEX = /\b(buy|purchase|mint)\b.*\b(nft|sentx|serial|collection)\b|\b(nft|sentx|serial|collection)\b.*\b(buy|purchase|mint)\b/i;
const MEMECOIN_PURCHASE_INTENT_REGEX = /\b(buy|purchase)\b.*\b(memecoin|meme\s*coin|memejob|token)\b|\b(memecoin|meme\s*coin|memejob|token)\b.*\b(buy|purchase)\b/i;

const MEMEJOB_SUPABASE_URL = 'https://afcwmixfmcntygibknfw.supabase.co';
const MEMEJOB_SUPABASE_ANON_KEY = process.env.MEMEJOB_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmY3dtaXhmbWNudHlnaWJrbmZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzAyMTk4NTcsImV4cCI6MjA0NTc5NTg1N30.sYYe5zTSTrJJiII2ug0PbDlubEVUgNTLewIok_dTMEY';
const SENTX_API_BASE_URL = 'https://gbackend.sentx.io';
const SENTX_API_KEY = (process.env.SENTX_API_KEY || '').trim();
const SENTX_API_KEY_HEADER = (process.env.SENTX_API_KEY_HEADER || 'x-api-key').trim();
const SAUCERSWAP_API_URL = 'https://api.saucerswap.finance/tokens';
const SAUCERSWAP_API_KEY = process.env.SAUCERSWAP_API_KEY
  || '875e1017-87b8-4b12-8301-6aa1f1aa073b';
const BONZO_API_BASE_URL = 'https://mainnet-data-staging.bonzo.finance';
const BONZO_API_KEY = (process.env.BONZO_API_KEY || '').trim();
const BONZO_API_KEY_HEADER = (process.env.BONZO_API_KEY_HEADER || 'x-api-key').trim();

function clampText(value, maxChars) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: clampText(m.content, MAX_MESSAGE_CHARS) }));
}

function normalizeAccountId(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    return trimmed;
  }
  if (/^\d+$/.test(trimmed)) {
    return `0.0.${trimmed}`;
  }
  return null;
}

function parseTransferPrompt(prompt) {
  const amountMatch = prompt.match(/(\d+(?:\.\d+)?)\s*hbar/i);
  const toMatch = prompt.match(/\bto\s+(?:account\s*)?(\d+\.\d+\.\d+|\d+)\b/i);
  const fromMatch = prompt.match(/\bfrom\s+(?:account\s*)?(\d+\.\d+\.\d+|\d+)\b/i);

  return {
    amount: amountMatch ? Number(amountMatch[1]) : null,
    toAccountId: toMatch ? normalizeAccountId(toMatch[1]) : null,
    fromAccountId: fromMatch ? normalizeAccountId(fromMatch[1]) : null,
  };
}

function parseBalancePrompt(prompt) {
  const explicit = prompt.match(/(?:account|wallet)\s+(\d+\.\d+\.\d+|\d+)/i);
  if (explicit) {
    return normalizeAccountId(explicit[1]);
  }
  const naked = prompt.match(/\b(\d+\.\d+\.\d+)\b/);
  if (naked) {
    return normalizeAccountId(naked[1]);
  }
  return process.env.HEDERA_ACCOUNT_ID;
}

function parseNftPurchasePrompt(prompt) {
  const tokenMatch = prompt.match(/\b(0\.0\.\d+)\b/i);
  const serialMatch = prompt.match(/(?:#|serial\s*)(\d+)/i);

  return {
    tokenId: tokenMatch ? tokenMatch[1] : null,
    serial: serialMatch ? Number(serialMatch[1]) : null,
  };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 12000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function getMirrorNodeRestBaseUrl(networkType) {
  return normalizeNetworkType(networkType) === 'mainnet'
    ? 'https://mainnet-public.mirrornode.hedera.com/api/v1'
    : 'https://testnet.mirrornode.hedera.com/api/v1';
}

function getHtsMarketDataNetworkType(prompt, requestedNetworkType) {
  const text = String(prompt || '').toLowerCase();
  if (text.includes('testnet')) {
    return 'testnet';
  }
  if (text.includes('mainnet')) {
    return 'mainnet';
  }
  return 'mainnet';
}

function extractTokenDecimals(tokenInfo) {
  const decimals = Number(tokenInfo?.decimals ?? 0);
  return Number.isFinite(decimals) && decimals >= 0 ? decimals : 0;
}

function extractTokenSupply(tokenInfo) {
  const rawSupply = tokenInfo?.total_supply ?? tokenInfo?.totalSupply ?? null;
  const supply = typeof rawSupply === 'string' ? Number(rawSupply) : Number(rawSupply);
  if (!Number.isFinite(supply)) {
    return null;
  }

  const decimals = extractTokenDecimals(tokenInfo);
  return supply / (10 ** decimals);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatTokenPrice(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 'n/a';
  }

  if (value >= 1) {
    return `$${value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })}`;
  }

  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 6,
    maximumFractionDigits: 10,
  })}`;
}

function formatTokenUnits(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function normalizeTokenLookupKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[^a-z0-9.]/g, '');
}

function extractTokenSearchTerms(prompt) {
  const text = String(prompt || '');
  const explicitTerms = new Set();

  for (const match of text.matchAll(/\b0\.0\.\d+\b/gi)) {
    explicitTerms.add(match[0]);
  }

  for (const match of text.matchAll(/\$([A-Za-z][A-Za-z0-9._-]{1,19})/g)) {
    explicitTerms.add(match[1]);
  }

  const symbolMatch = text.match(/\bsymbol\s+([A-Za-z0-9.\[\]-]{2,20})\b/i);
  if (symbolMatch) {
    explicitTerms.add(symbolMatch[1]);
  }

  const stopWords = new Set([
    'a',
    'an',
    'and',
    'cap',
    'caps',
    'current',
    'fdv',
    'for',
    'fully',
    'hts',
    'is',
    'liquidity',
    'latest',
    'market',
    'marketcap',
    'largest',
    'live',
    'of',
    'on',
    'price',
    'real',
    'ranking',
    'rankings',
    'supply',
    'the',
    'time',
    'token',
    'tokens',
    'top',
    'value',
    'volume',
    'what',
    'whats',
  ]);

  if (explicitTerms.size) {
    return [...explicitTerms].slice(0, 6);
  }

  const contentWords = [];
  const words = text.match(/[A-Za-z][A-Za-z0-9.-]{1,24}/g) || [];
  for (const word of words) {
    const normalized = normalizeTokenLookupKey(word);
    if (normalized.length >= 2 && !stopWords.has(normalized)) {
      contentWords.push(word);
    }
  }

  if (contentWords.length <= 2) {
    return [...new Set(contentWords)].slice(0, 6);
  }

  return [];
}

function getTokenMatchScore(token, searchTerms) {
  const tokenId = String(token?.id || token?.token_id || '');
  const normalizedId = normalizeTokenLookupKey(tokenId);
  const symbol = String(token?.symbol || '');
  const normalizedSymbol = normalizeTokenLookupKey(symbol);
  const name = String(token?.name || '');
  const normalizedName = normalizeTokenLookupKey(name);
  const nameWords = name
    .split(/[^A-Za-z0-9.]+/)
    .map((word) => normalizeTokenLookupKey(word))
    .filter(Boolean);

  return searchTerms.reduce((score, term) => {
    const normalizedTerm = normalizeTokenLookupKey(term);
    if (!normalizedTerm) {
      return score;
    }
    if (normalizedId && normalizedId === normalizedTerm) {
      return score + 300;
    }
    if (normalizedSymbol && normalizedSymbol === normalizedTerm) {
      return score + 220;
    }
    if (normalizedName && normalizedName === normalizedTerm) {
      return score + 180;
    }
    if (nameWords.includes(normalizedTerm)) {
      return score + 140;
    }
    if (normalizedSymbol && normalizedSymbol.includes(normalizedTerm)) {
      return score + 90;
    }
    if (normalizedName && normalizedName.includes(normalizedTerm)) {
      return score + 70;
    }
    return score;
  }, 0);
}

function mergeRankedTokens(snapshot, tokens, searchTerms) {
  const merged = new Map();

  for (const token of tokens) {
    const tokenId = token?.id || token?.token_id;
    if (!tokenId) {
      continue;
    }

    const pricedToken = snapshot.tokens.find((candidate) => candidate.id === tokenId);
    const mergedToken = pricedToken
      ? { ...token, ...pricedToken, id: tokenId }
      : {
        id: tokenId,
        name: token?.name || 'Unknown token',
        symbol: token?.symbol || '',
        priceUsd: null,
      };

    const score = getTokenMatchScore(mergedToken, searchTerms)
      + (Number.isFinite(Number(mergedToken.priceUsd)) && Number(mergedToken.priceUsd) > 0 ? 5 : 0);

    const existing = merged.get(tokenId);
    if (!existing || score > existing.score) {
      merged.set(tokenId, { token: mergedToken, score });
    }
  }

  return [...merged.values()]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.token.priceUsd || 0) - Number(a.token.priceUsd || 0))
    .map((entry) => entry.token);
}

async function searchMirrorNodeTokens(term, networkType) {
  const baseUrl = getMirrorNodeRestBaseUrl(networkType);
  const trimmedTerm = String(term || '').trim();
  if (!trimmedTerm) {
    return [];
  }

  if (/^0\.0\.\d+$/.test(trimmedTerm)) {
    try {
      const token = await getMirrorNodeTokenInfo(trimmedTerm, networkType);
      return token ? [token] : [];
    } catch {
      return [];
    }
  }

  const [bySymbol, byName] = await Promise.all([
    fetchJson(`${baseUrl}/tokens?symbol=${encodeURIComponent(trimmedTerm)}&limit=10`).catch(() => ({ tokens: [] })),
    fetchJson(`${baseUrl}/tokens?name=${encodeURIComponent(trimmedTerm)}&limit=10`).catch(() => ({ tokens: [] })),
  ]);

  return [...(Array.isArray(bySymbol?.tokens) ? bySymbol.tokens : []), ...(Array.isArray(byName?.tokens) ? byName.tokens : [])];
}

async function resolveHtsMarketTokens(prompt, networkType, snapshot) {
  const searchTerms = extractTokenSearchTerms(prompt);
  if (!searchTerms.length) {
    return [];
  }

  const snapshotMatches = snapshot.tokens.filter((token) => getTokenMatchScore(token, searchTerms) > 0);
  const mirrorMatches = await Promise.all(searchTerms.slice(0, 4).map((term) => searchMirrorNodeTokens(term, networkType)));

  return mergeRankedTokens(snapshot, [...snapshotMatches, ...mirrorMatches.flat()], searchTerms).slice(0, 5);
}

function getRequestedHtsTokenLimit(prompt) {
  const searchTerms = extractTokenSearchTerms(prompt);
  if (!searchTerms.length) {
    return 5;
  }

  return Math.min(5, searchTerms.length);
}

async function getMirrorNodeTokenInfo(tokenId, networkType) {
  const baseUrl = getMirrorNodeRestBaseUrl(networkType);
  return fetchJson(`${baseUrl}/tokens/${encodeURIComponent(tokenId)}`);
}

async function getSentxSnapshot() {
  const sentxAuthHeaders = SENTX_API_KEY
    ? { [SENTX_API_KEY_HEADER]: SENTX_API_KEY }
    : {};

  const [featuredRes, salesRes, launchpadRes] = await Promise.all([
    fetchJson(`${SENTX_API_BASE_URL}/global/getfeatured`, { headers: sentxAuthHeaders }),
    fetchJson(`${SENTX_API_BASE_URL}/global/getSalesOfTheWeek`, { headers: sentxAuthHeaders }),
    fetchJson(
      `${SENTX_API_BASE_URL}/getcollectionlist?mintEventType=index&limit=6&offset=0&sortOption=latest-activity`,
      { headers: sentxAuthHeaders },
    ),
  ]);

  const featured = Array.isArray(featuredRes?.data?.featured) ? featuredRes.data.featured : [];
  const weeklySales = Array.isArray(salesRes?.data) ? salesRes.data : [];
  const launchpad = Array.isArray(launchpadRes?.response) ? launchpadRes.response : [];

  const topCollections = featured
    .map((item) => ({
    name: item?.stats?.name || item?.name || 'Unknown collection',
    tokenId: item?.stats?.token || item?.stats?.address || null,
    volumeHbar: Number(item?.stats?.volume || 0),
    floorHbar: Number(item?.stats?.floor || 0),
    sales: Number(item?.stats?.sales || 0),
    }))
    .filter((item) => item.name !== 'Unknown collection' && (item.volumeHbar > 0 || item.sales > 0))
    .slice(0, 5);

  const topSales = weeklySales.slice(0, 5).map((sale) => ({
    nftName: sale?.name || 'Unknown NFT',
    collectionName: sale?.cname || 'Unknown collection',
    tokenId: sale?.tokenAddress || null,
    serial: sale?.serialId ?? null,
    priceHbar: Number(sale?.price || 0),
  }));

  const launchpadHighlights = launchpad.slice(0, 4).map((item) => ({
    name: item?.collectionname || item?.name || item?.mintevents?.[0]?.name || 'Unknown project',
    tokenId: item?.address || item?.tokenAddress || item?.token || null,
    mintPriceHbar: Number(item?.mintevents?.[0]?.stages?.[0]?.mintCost || item?.price || item?.mintPrice || 0),
  }));

  return {
    asOf: new Date().toISOString(),
    source: SENTX_API_BASE_URL,
    topCollections,
    topSales,
    launchpadHighlights,
  };
}

async function getMemejobSnapshot() {
  const url = `${MEMEJOB_SUPABASE_URL}/rest/v1/tokens?select=token_id,name,ticker,price,hbar_supply,created_at,modified_at,is_valid,is_nsfw&is_valid=eq.true&order=modified_at.desc&limit=12`;
  const rows = await fetchJson(url, {
    headers: {
      apikey: MEMEJOB_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${MEMEJOB_SUPABASE_ANON_KEY}`,
    },
  });

  const tokens = Array.isArray(rows)
    ? rows.map((row) => ({
      tokenId: row.token_id || null,
      name: row.name || 'Unknown token',
      ticker: row.ticker || '',
      price: Number(row.price || 0),
      hbarSupply: Number(row.hbar_supply || 0),
      modifiedAt: row.modified_at || row.created_at || null,
      isNsfw: Boolean(row.is_nsfw),
    }))
    : [];

  const latest = tokens.slice(0, 8);
  const byPrice = [...tokens]
    .filter((t) => Number.isFinite(t.price))
    .sort((a, b) => b.price - a.price)
    .slice(0, 5);

  return {
    asOf: new Date().toISOString(),
    source: `${MEMEJOB_SUPABASE_URL}/rest/v1/tokens`,
    latest,
    byPrice,
  };
}

async function getSaucerSwapSnapshot(prompt) {
  const rows = await fetchJson(SAUCERSWAP_API_URL, {
    headers: {
      'x-api-key': SAUCERSWAP_API_KEY,
    },
  });

  const tokens = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: row?.id || null,
      name: row?.name || 'Unknown token',
      symbol: row?.symbol || '',
      priceUsd: Number(row?.priceUsd || 0),
      priceRaw: row?.price || null,
      dueDiligenceComplete: Boolean(row?.dueDiligenceComplete),
      inTopPools: Boolean(row?.inTopPools),
      inV2Pools: Boolean(row?.inV2Pools),
    }))
    .filter((t) => t.id);

  const tokenIdQuery = prompt.match(/\b0\.0\.\d+\b/i)?.[0] || null;
  const symbolQuery = prompt.match(/\bsymbol\s+([A-Za-z0-9.\[\]-]{2,20})\b/i)?.[1]?.toUpperCase() || null;

  const matched = tokens.filter((t) => {
    if (tokenIdQuery && t.id === tokenIdQuery) {
      return true;
    }
    if (symbolQuery && t.symbol.toUpperCase() === symbolQuery) {
      return true;
    }
    return false;
  });

  const featured = [...tokens]
    .filter((t) => t.inTopPools || t.dueDiligenceComplete)
    .sort((a, b) => b.priceUsd - a.priceUsd)
    .slice(0, 10);

  return {
    asOf: new Date().toISOString(),
    source: SAUCERSWAP_API_URL,
    tokenCount: tokens.length,
    matched,
    featured,
    tokens,
  };
}

async function buildSaucerSwapExpertAnswer(prompt) {
  const snapshot = await getSaucerSwapSnapshot(prompt);
  const promptLower = String(prompt || '').toLowerCase();

  const keywordMatches = snapshot.tokens
    .filter((t) => {
      const symbol = String(t.symbol || '').toLowerCase();
      const name = String(t.name || '').toLowerCase();
      return (symbol && promptLower.includes(symbol))
        || (name && promptLower.includes(name))
        || (t.id && promptLower.includes(String(t.id).toLowerCase()));
    })
    .slice(0, 6);

  const focus = snapshot.matched.length ? snapshot.matched : keywordMatches;
  const topByPrice = [...snapshot.tokens]
    .filter((t) => Number.isFinite(t.priceUsd))
    .sort((a, b) => b.priceUsd - a.priceUsd)
    .slice(0, 8);
  const topPools = snapshot.tokens
    .filter((t) => t.inTopPools)
    .slice(0, 12);
  const dueDiligenceComplete = snapshot.tokens
    .filter((t) => t.dueDiligenceComplete)
    .slice(0, 12);

  const groundedContext = {
    asOf: snapshot.asOf,
    source: snapshot.source,
    tokenCount: snapshot.tokenCount,
    focus,
    topByPrice,
    topPools,
    dueDiligenceComplete,
  };

  const result = await generateText({
    model: baseModel,
    system:
      `${BASE_SYSTEM_PROMPT} You are a SaucerSwap expert assistant. `
      + 'Use only the provided live SaucerSwap data. If a requested fact is not present in this data, say so directly. '
      + 'Keep responses concise and practical for traders/developers.',
    prompt:
      `User question: ${prompt}\n\n`
      + `Live SaucerSwap data (JSON):\n${JSON.stringify(groundedContext, null, 2)}\n\n`
      + 'Answer with: (1) direct answer, (2) key supporting token data points, and (3) one short caveat if data is limited.',
  });

  return result.text;
}

async function buildHtsMarketCapAnswer(prompt, networkType) {
  const marketDataNetworkType = getHtsMarketDataNetworkType(prompt, networkType);
  const snapshot = await getSaucerSwapSnapshot(prompt);
  const requestedTokens = await resolveHtsMarketTokens(prompt, marketDataNetworkType, snapshot);
  const requestedTokenLimit = getRequestedHtsTokenLimit(prompt);
  const rankedMarketTokens = [...snapshot.tokens]
    .filter((t) => Number.isFinite(t.priceUsd) && t.priceUsd > 0 && (t.inTopPools || t.dueDiligenceComplete))
    .sort((a, b) => b.priceUsd - a.priceUsd);
  const fallbackTokens = [
    ...snapshot.featured,
    ...rankedMarketTokens.slice(0, 40),
  ];
  const candidateTokens = (requestedTokens.length ? requestedTokens : fallbackTokens)
    .filter((token, index, tokens) => tokens.findIndex((candidate) => candidate.id === token.id) === index)
    .slice(0, requestedTokens.length ? requestedTokenLimit : 40);

  const tokenRows = await Promise.all(candidateTokens.map(async (token) => {
    try {
      const tokenInfo = await getMirrorNodeTokenInfo(token.id, marketDataNetworkType);
      const totalSupply = extractTokenSupply(tokenInfo);
      const decimals = extractTokenDecimals(tokenInfo);
      const priceUsd = Number(token.priceUsd);
      const marketCapUsd = Number.isFinite(totalSupply) && Number.isFinite(priceUsd) && priceUsd > 0
        ? totalSupply * priceUsd
        : null;

      return {
        token,
        priceUsd,
        totalSupply,
        decimals,
        marketCapUsd,
      };
    } catch (error) {
      return {
        token,
        priceUsd: Number(token.priceUsd),
        totalSupply: null,
        decimals: null,
        marketCapUsd: null,
        error: error?.message || String(error),
      };
    }
  }));

  const orderedRows = requestedTokens.length
    ? tokenRows
    : [...tokenRows]
      .filter((row) => Number.isFinite(row.marketCapUsd))
      .sort((a, b) => (b.marketCapUsd || 0) - (a.marketCapUsd || 0))
      .slice(0, 5);

  if (!orderedRows.length) {
    return `HTS live market data is currently unavailable for that prompt. Source checked: ${snapshot.source}.`;
  }

  if (requestedTokens.length && orderedRows.length === 1) {
    const row = orderedRows[0];
    const tokenLabel = `${row.token.name}${row.token.symbol ? ` (${row.token.symbol})` : ''}`;
    const tokenId = row.token.id || 'n/a';
    const marketCap = Number.isFinite(row.marketCapUsd) ? formatUsd(row.marketCapUsd) : 'n/a';
    return `${tokenLabel} [${tokenId}]: ${marketCap}`;
  }

  const header = `HTS live market data (sources: SaucerSwap + Hedera Mirror Node ${marketDataNetworkType}, as of ${snapshot.asOf}):`;
  const lines = orderedRows.map((row, index) => {
    const tokenLabel = `${row.token.name}${row.token.symbol ? ` (${row.token.symbol})` : ''}`;
    const tokenId = row.token.id || 'n/a';
    const marketCap = Number.isFinite(row.marketCapUsd) ? formatUsd(row.marketCapUsd) : 'n/a';
    const price = formatTokenPrice(row.priceUsd);
    const supply = formatTokenUnits(row.totalSupply);
    const caveat = marketCap === 'n/a'
      ? 'No live USD price was available from SaucerSwap for this token, so market cap could not be computed.'
      : null;

    return `${index + 1}. ${tokenLabel} [${tokenId}]\nPrice: ${price}\nTotal supply: ${supply}\nMarket cap: ${marketCap}${caveat ? `\nNote: ${caveat}` : ''}`;
  }).join('\n\n');

  return `${header}\n\n${lines}`;
}

async function tryFetchBonzoEndpoint(path) {
  const url = `${BONZO_API_BASE_URL}${path}`;
  const bonzoAuthHeaders = BONZO_API_KEY
    ? { [BONZO_API_KEY_HEADER]: BONZO_API_KEY }
    : {};

  try {
    const data = await fetchJson(url, {
      headers: {
        ...bonzoAuthHeaders,
      },
    });
    return { ok: true, url, data };
  } catch (error) {
    return { ok: false, url, error: error?.message || String(error) };
  }
}

async function fetchBonzoFirstAvailable(paths) {
  const attempts = [];
  for (const path of paths) {
    const result = await tryFetchBonzoEndpoint(path);
    attempts.push(result);
    if (result.ok) {
      return {
        success: result,
        attempts,
      };
    }
  }
  return { success: null, attempts };
}

async function getBonzoSnapshot(prompt) {
  const accountId = prompt.match(/\b\d+\.\d+\.\d+\b/)?.[0] || null;

  const endpointGroups = [
    {
      key: 'market',
      label: 'Market Information',
      paths: ['/market', '/v1/market', '/api/market', '/api/v1/market'],
    },
    {
      key: 'stats',
      label: 'Pool Statistics',
      paths: ['/stats', '/v1/stats', '/api/stats', '/api/v1/stats'],
    },
    {
      key: 'debtors',
      label: 'List of Debtors',
      paths: ['/debtors', '/v1/debtors', '/api/debtors', '/api/v1/debtors'],
    },
    {
      key: 'bonzoSupply',
      label: 'BONZO Circulation Supply',
      paths: ['/bonzo/circulation', '/bonzo/circulating-supply', '/circulation', '/supply'],
    },
  ];

  if (accountId) {
    endpointGroups.unshift({
      key: 'dashboard',
      label: `Account Dashboard (${accountId})`,
      paths: [
        `/dashboard/${accountId}`,
        `/v1/dashboard/${accountId}`,
        `/api/dashboard/${accountId}`,
        `/api/v1/dashboard/${accountId}`,
      ],
    });
  }

  const results = {};

  for (const group of endpointGroups) {
    results[group.key] = {
      label: group.label,
      ...(await fetchBonzoFirstAvailable(group.paths)),
    };
  }

  return {
    asOf: new Date().toISOString(),
    source: BONZO_API_BASE_URL,
    accountId,
    authHeaderConfigured: Boolean(BONZO_API_KEY),
    authHeaderName: BONZO_API_KEY ? BONZO_API_KEY_HEADER : null,
    results,
  };
}

async function maybeHandleMemejobMarketAction({ prompt, history }) {
  if (!MEMEJOB_MARKET_ACTION_INTENT_REGEX.test(prompt)) {
    return { handled: false };
  }

  if (!memejobToolModel || !memejobToolkit) {
    return {
      handled: true,
      response: 'Memejob actions are temporarily unavailable because Hedera operator credentials are not configured on this deployment.',
    };
  }

  const normalizedHistory = normalizeHistory(history);
  const toolResult = await generateText({
    model: memejobToolModel,
    system:
      `${BASE_SYSTEM_PROMPT} You can directly interact with memejob markets using plugin tools (create, buy, sell memecoins). `
      + 'If a required parameter is missing, ask only for the missing value(s). Execute once details are complete.',
    messages: [...normalizedHistory, { role: 'user', content: prompt }],
    tools: memejobToolkit.getTools(),
    stopWhen: stepCountIs(6),
  });

  return {
    handled: true,
    response: toolResult.text,
  };
}

function parseMemeCoinPurchasePrompt(prompt) {
  const tokenMatch = prompt.match(/\b(0\.0\.\d+)\b/i);
  const amountMatch = prompt.match(/\bamount\s*[:=]?\s*(\d+(?:\.\d+)?)\b/i)
    || prompt.match(/\b(\d+(?:\.\d+)?)\s*(?:tokens?|units?)\b/i);

  return {
    tokenId: tokenMatch ? tokenMatch[1] : null,
    amount: amountMatch ? Number(amountMatch[1]) : null,
  };
}

async function maybeHandleNftMarketAction({ prompt, walletConnected, walletAccountId }) {
  if (!NFT_MARKET_ACTION_INTENT_REGEX.test(prompt)) {
    return { handled: false };
  }

  const { tokenId, serial } = parseNftPurchasePrompt(prompt);
  const marketplaceUrlBase = 'https://sentx.io/nft-marketplace/activity';
  const searchQuery = tokenId && serial ? `${tokenId}#${serial}` : tokenId || '';
  const actionUrl = searchQuery
    ? `${marketplaceUrlBase}?search=${encodeURIComponent(searchQuery)}`
    : marketplaceUrlBase;

  const connectedAccountId = normalizeAccountId(walletAccountId);

  if (!walletConnected || !connectedAccountId) {
    return {
      handled: true,
      actionUrl: null,
      response:
        'To purchase NFTs, connect your HashPack wallet first (or reconnect if session expired). '
        + 'For precise targeting, use: "buy nft 0.0.TOKEN_ID#SERIAL on SentX".',
    };
  }

  if (!tokenId || !serial) {
    const networkType = getNetworkType(connectedAccountId);
    return {
      handled: true,
      actionUrl,
      response:
        `Using connected wallet ${connectedAccountId} (${networkType}). I opened SentX marketplace. To target a specific NFT listing, provide both token ID and serial, for example: `
        + '"buy nft 0.0.1234567#42 on SentX".',
    };
  }

  const networkType = getNetworkType(connectedAccountId);
  return {
    handled: true,
    actionUrl,
    response:
      `Using connected wallet ${connectedAccountId} (${networkType}), I opened SentX with listing context for ${tokenId}#${serial}. Complete the purchase in HashPack when prompted.`,
  };
}

async function maybeHandleMemeCoinPurchaseAction({ prompt, walletConnected, walletAccountId }) {
  if (!MEMECOIN_PURCHASE_INTENT_REGEX.test(prompt)) {
    return { handled: false };
  }

  const { tokenId, amount } = parseMemeCoinPurchasePrompt(prompt);
  const actionUrl = 'https://www.memejob.fun';
  const connectedAccountId = normalizeAccountId(walletAccountId);

  if (!walletConnected || !connectedAccountId) {
    return {
      handled: true,
      actionUrl: null,
      response:
        'To buy memecoins, connect your HashPack wallet first (or reconnect if session expired). '
        + 'Then prompt: "buy memecoin 0.0.TOKEN_ID amount 100 on memejob".',
    };
  }

  if (!tokenId || !amount || !Number.isFinite(amount) || amount <= 0) {
    const networkType = getNetworkType(connectedAccountId);
    return {
      handled: true,
      actionUrl,
      response:
        `Using connected wallet ${connectedAccountId} (${networkType}), I opened memejob in a new tab. Provide both token ID and amount so I can target your buy intent, for example: `
        + '"buy memecoin 0.0.123456 amount 100 on memejob".',
    };
  }

  const networkType = getNetworkType(connectedAccountId);
  return {
    handled: true,
    actionUrl,
    response:
      `Using connected wallet ${connectedAccountId} (${networkType}), I opened memejob for checkout. Buy ${amount} units of ${tokenId} there and approve in HashPack.`,
  };
}

async function maybeHandleProjectDataIntent(prompt, networkType) {
  if (SENTX_INTENT_REGEX.test(prompt)) {
    const snapshot = await getSentxSnapshot();

    const collections = snapshot.topCollections.length
      ? snapshot.topCollections
        .map((c, i) => `${i + 1}. ${c.name} (${c.tokenId || 'n/a'}) - volume: ${c.volumeHbar.toLocaleString()} HBAR, floor: ${c.floorHbar.toLocaleString()} HBAR, sales: ${c.sales}`)
        .join('\n')
      : 'No collection data returned.';

    const sales = snapshot.topSales.length
      ? snapshot.topSales
        .map((s, i) => `${i + 1}. ${s.nftName} (${s.collectionName}) - ${s.priceHbar.toLocaleString()} HBAR${s.tokenId ? ` [${s.tokenId}${s.serial ? `#${s.serial}` : ''}]` : ''}`)
        .join('\n')
      : 'No recent sales returned.';

    const launchpad = snapshot.launchpadHighlights.length
      ? snapshot.launchpadHighlights
        .map((p, i) => `${i + 1}. ${p.name}${p.tokenId ? ` (${p.tokenId})` : ''}${p.mintPriceHbar > 0 ? ` - mint price: ${p.mintPriceHbar.toLocaleString()} HBAR` : ''}`)
        .join('\n')
      : 'No launchpad highlights returned.';

    return {
      handled: true,
      response:
        `SentX real-time NFT snapshot (source: ${snapshot.source}, as of ${snapshot.asOf}):\n\n`
        + `Top SentX collections:\n${collections}\n\n`
        + `Top SentX sales this week:\n${sales}\n\n`
        + `SentX launchpad highlights:\n${launchpad}`,
    };
  }

  if (MEMEJOB_INTENT_REGEX.test(prompt)) {
    const snapshot = await getMemejobSnapshot();

    const latest = snapshot.latest.length
      ? snapshot.latest
        .map((t, i) => `${i + 1}. ${t.name}${t.ticker ? ` (${t.ticker})` : ''} - token: ${t.tokenId || 'n/a'}, price: ${t.price.toLocaleString()}, hbarSupply: ${t.hbarSupply.toLocaleString()}, updated: ${t.modifiedAt || 'n/a'}`)
        .join('\n')
      : 'No memecoin rows returned.';

    const priced = snapshot.byPrice.length
      ? snapshot.byPrice
        .map((t, i) => `${i + 1}. ${t.name}${t.ticker ? ` (${t.ticker})` : ''} - price: ${t.price.toLocaleString()} (token ${t.tokenId || 'n/a'})`)
        .join('\n')
      : 'No priced memecoin rows returned.';

    return {
      handled: true,
      response:
        `memejob.fun real-time memecoin snapshot (source: ${snapshot.source}, as of ${snapshot.asOf}):\n\n`
        + `Latest active memecoins:\n${latest}\n\n`
        + `Top by current price field:\n${priced}`,
    };
  }

  if (HTS_MARKET_CAP_INTENT_REGEX.test(prompt)) {
    const marketCapAnswer = await buildHtsMarketCapAnswer(prompt, networkType);
    return {
      handled: true,
      response: marketCapAnswer,
    };
  }

  if (SAUCERSWAP_INTENT_REGEX.test(prompt)) {
    const expertAnswer = await buildSaucerSwapExpertAnswer(prompt);
    return {
      handled: true,
      response: expertAnswer,
    };
  }

  if (BONZO_INTENT_REGEX.test(prompt)) {
    const snapshot = await getBonzoSnapshot(prompt);
    const lines = [];
    const unavailableLabels = [];

    const getDisplay = (obj) => {
      if (!obj || typeof obj !== 'object') {
        return null;
      }
      return obj.usd_display || obj.token_display || obj.hbar_display || null;
    };

    for (const section of Object.values(snapshot.results)) {
      if (section.success) {
        const payload = section.success.data;
        if (section.label === 'Market Information' && payload && typeof payload === 'object') {
          const supplied = getDisplay(payload.total_market_supplied);
          const borrowed = getDisplay(payload.total_market_borrowed);
          const liquidity = getDisplay(payload.total_market_liquidity);
          const reserveCount = Array.isArray(payload.reserves) ? payload.reserves.length : null;
          lines.push(
            `- Market: supplied ${supplied || 'n/a'}, borrowed ${borrowed || 'n/a'}, liquidity ${liquidity || 'n/a'}${reserveCount !== null ? `, reserves ${reserveCount}` : ''}`,
          );
          continue;
        }

        if (section.label === 'Pool Statistics' && payload && typeof payload === 'object') {
          const users = Array.isArray(payload.active_users)
            ? payload.active_users.length
            : (payload.active_users ?? 'n/a');
          const borrows = payload.total_borrows_count ?? 'n/a';
          const deposits = payload.total_deposits_count ?? 'n/a';
          const liquidations = payload.total_liquidations_count ?? 'n/a';
          lines.push(
            `- Stats (24h): active users ${users}, borrows ${borrows}, deposits ${deposits}, liquidations ${liquidations}`,
          );
          continue;
        }

        if (section.label === 'List of Debtors' && payload && typeof payload === 'object') {
          const debtorsCount = Array.isArray(payload.debtors) ? payload.debtors.length : 'n/a';
          lines.push(`- Debtors: ${debtorsCount} accounts with outstanding debt`);
          continue;
        }

        if (section.label === 'BONZO Circulation Supply' && payload && typeof payload === 'object') {
          lines.push(
            `- BONZO supply: ${payload.hbar_display || 'n/a'} BONZO (${payload.usd_display || 'n/a'} USD)`,
          );
          continue;
        }

        if (section.label.startsWith('Account Dashboard') && payload && typeof payload === 'object') {
          const credit = payload.user_credit || {};
          const supplied = getDisplay(credit.total_supply);
          const debt = getDisplay(credit.total_debt);
          const walletHbar = credit?.hbar_balance?.hbar_display || null;
          const hf = credit.health_factor ?? 'n/a';
          lines.push(
            `- Dashboard: supplied ${supplied || 'n/a'}, debt ${debt || 'n/a'}, wallet balance ${walletHbar || 'n/a'} HBAR, health factor ${hf}`,
          );
          continue;
        }

        const summary = Array.isArray(payload)
          ? `array(${payload.length})`
          : payload && typeof payload === 'object'
            ? `object keys: ${Object.keys(payload).slice(0, 8).join(', ') || 'none'}`
            : String(payload);
        lines.push(`- ${section.label}: ${summary}`);
      } else {
        unavailableLabels.push(section.label);
      }
    }

    const successCount = Object.values(snapshot.results).filter((s) => Boolean(s.success)).length;

    return {
      handled: true,
      response:
        `Bonzo API connectivity snapshot (source: ${snapshot.source}, as of ${snapshot.asOf}).\n`
        + `Auth header configured: ${snapshot.authHeaderConfigured ? `yes (${snapshot.authHeaderName})` : 'no'}.\n`
        + `${snapshot.accountId ? `Account context: ${snapshot.accountId}.\n` : ''}`
        + `Successful endpoint groups: ${successCount}/${Object.keys(snapshot.results).length}.\n\n`
        + (lines.length ? `${lines.join('\n')}\n\n` : '')
        + (unavailableLabels.length && successCount > 0
          ? `Some Bonzo groups are temporarily unavailable: ${unavailableLabels.join(', ')}.\n\n`
          : '')
        + (successCount === 0
          ? 'Bonzo endpoints are currently failing upstream (HTTP 403/500). This usually indicates API-side access or server issues, not a chat app bug. Integration is wired, and these calls will populate automatically once Bonzo responds successfully.'
          : 'Live Bonzo data has been connected for the successful groups above.')
    };
  }

  return { handled: false };
}

function isHtsMarketDataPrompt(prompt) {
  const text = String(prompt || '');
  return HTS_MARKET_CAP_INTENT_REGEX.test(text)
    || (/\bhts\b/i.test(text) && /\b(price|prices|liquidity|volume|ranking|rankings|top|largest)\b/i.test(text));
}

function getMirrorNodeBaseUrl(networkType) {
  return normalizeNetworkType(networkType) === 'mainnet'
    ? 'https://mainnet-public.mirrornode.hedera.com'
    : 'https://testnet.mirrornode.hedera.com';
}

async function getWalletSnapshot(accountId, networkType) {
  const mirrorNodeBaseUrl = getMirrorNodeBaseUrl(networkType);
  const response = await fetch(`${mirrorNodeBaseUrl}/api/v1/accounts/${accountId}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Mirror node request failed (${response.status}) for account ${accountId}`);
  }

  const data = await response.json();
  const tinybars = Number(data.balance?.balance || 0);
  const hbar = tinybars / 1e8;

  const tokens = Array.isArray(data.balance?.tokens)
    ? data.balance.tokens.slice(0, 15).map((t) => ({ tokenId: t.token_id, balance: t.balance }))
    : [];

  return { accountId, hbar, tokens };
}

async function executeHbarTransfer({ amount, toAccountId, fromAccountId, sourcePrivateKey }) {
  if (!operatorClient) {
    throw new Error('HBAR transfer is unavailable because HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY is not configured.');
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Transfer amount must be a positive number of HBAR.');
  }
  if (!toAccountId) {
    throw new Error('Destination account is required.');
  }

  const resolvedFrom = fromAccountId || process.env.HEDERA_ACCOUNT_ID;
  const resolvedTo = normalizeAccountId(toAccountId);
  if (!resolvedTo) {
    throw new Error('Destination account format is invalid. Use 0.0.x or x.');
  }

  let txClient = operatorClient;
  let signerKey = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY);

  if (resolvedFrom !== process.env.HEDERA_ACCOUNT_ID) {
    if (!sourcePrivateKey) {
      throw new Error('Source private key is required when transferring from a non-operator account.');
    }
    signerKey = PrivateKey.fromStringECDSA(sourcePrivateKey);
    txClient = Client.forName(configuredNetworkType).setOperator(resolvedFrom, signerKey);
  }

  const tx = await new TransferTransaction()
    .addHbarTransfer(resolvedFrom, new Hbar(-amount))
    .addHbarTransfer(resolvedTo, new Hbar(amount))
    .freezeWith(txClient)
    .sign(signerKey);

  const submit = await tx.execute(txClient);
  const receipt = await submit.getReceipt(txClient);

  return {
    status: receipt.status.toString(),
    transactionId: String(submit.transactionId),
    from: resolvedFrom,
    to: resolvedTo,
    amount,
  };
}

async function maybeExecuteWalletAction({ prompt, fromAccountId, privateKey, walletAccountId, walletConnected }) {
  if (TRANSFER_INTENT_REGEX.test(prompt)) {
    if (!walletConnected || !walletAccountId) {
      return {
        handled: true,
        response: 'HBAR transfers require a connected HashPack wallet in the browser. Please connect HashPack, then retry the transfer from chat.',
      };
    }

    return {
      handled: true,
      response:
        'Wallet connected. HBAR transfers are executed client-side through HashPack signing in this chat UI. Submit the transfer prompt from the connected browser session to execute it.',
    };
  }

  if (BALANCE_INTENT_REGEX.test(prompt)) {
    const isMyBalanceRequest = MY_BALANCE_INTENT_REGEX.test(prompt);

    if (isMyBalanceRequest) {
      if (!walletConnected || !walletAccountId) {
        return {
          handled: true,
          response: 'To check your HBAR balance, connect your HashPack wallet first.',
        };
      }

      const connectedAccountId = normalizeAccountId(walletAccountId);
      const connectedNetworkType = getNetworkType(connectedAccountId);
      if (!connectedAccountId) {
        return {
          handled: true,
          response: 'Connected wallet account is invalid. Please reconnect your wallet and try again.',
        };
      }

      const snapshot = await getWalletSnapshot(connectedAccountId, connectedNetworkType);
      const tokenLines = snapshot.tokens.length
        ? `\nTop token balances:\n${snapshot.tokens.map((t) => `- ${t.tokenId}: ${t.balance}`).join('\n')}`
        : '';

      return {
        handled: true,
        response: `Your connected wallet (${snapshot.accountId} - ${connectedNetworkType}) balance: ${snapshot.hbar.toFixed(8)} HBAR.${tokenLines}`,
      };
    }

    const accountId = parseBalancePrompt(prompt);
    const accountNetworkType = getNetworkType(accountId);
    const snapshot = await getWalletSnapshot(accountId, accountNetworkType);

    const tokenLines = snapshot.tokens.length
      ? `\nTop token balances:\n${snapshot.tokens.map((t) => `- ${t.tokenId}: ${t.balance}`).join('\n')}`
      : '';

    return {
      handled: true,
      response: `Account ${snapshot.accountId} balance: ${snapshot.hbar.toFixed(8)} HBAR.${tokenLines}`,
    };
  }

  return { handled: false };
}

// Final refinement to ensure getNetworkType always returns 'testnet' or 'mainnet'
function getNetworkType(accountId, walletNetworkType) {
  if (walletNetworkType) {
    const walletResolved = normalizeNetworkType(walletNetworkType);
    if (supportedNetworkTypes.includes(walletResolved)) {
      return walletResolved;
    }
  }

  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return configuredNetworkType;
  }

  return configuredNetworkType;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/client-config', (req, res) => {
  res.json({
    network: configuredNetworkType,
    defaultNetwork: configuredNetworkType,
    supportedNetworks: supportedNetworkTypes,
    hashconnectProjectId: process.env.HASHCONNECT_PROJECT_ID || '',
  });
});

// POST /agent
// Body: { prompt: string, history?: Array<{role: 'user'|'assistant', content: string}>, fromAccountId?: string, privateKey?: string }
app.post('/agent', async (req, res) => {
  const {
    prompt,
    history,
    fromAccountId,
    privateKey,
    walletAccountId,
    walletConnected,
    walletNetworkType,
  } = req.body;
  const networkType = getNetworkType(walletAccountId, walletNetworkType);

  if (networkType === 'testnet') {
    if (MEMEJOB_MARKET_ACTION_INTENT_REGEX.test(prompt) || NFT_MARKET_ACTION_INTENT_REGEX.test(prompt)) {
      return res.json({
        response: 'Transactions for memecoins or NFTs are not allowed on the testnet.',
        actionUrl: null,
        networkType,
        walletConnected,
        walletAccountId,
      });
    }
  }

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing prompt field.' });
  }

  if (!baseModel) {
    return res.status(503).json({
      error: 'OPENAI_API_KEY is missing on this deployment. Configure it in Vercel Project Settings -> Environment Variables.',
    });
  }

  const trimmedPrompt = clampText(prompt, MAX_MESSAGE_CHARS);

  try {
    if (isHtsMarketDataPrompt(trimmedPrompt)) {
      const marketCapAnswer = await buildHtsMarketCapAnswer(trimmedPrompt, networkType);
      return res.json({
        response: marketCapAnswer,
        actionUrl: null,
        networkType,
      });
    }

    const memecoinPurchaseResult = await maybeHandleMemeCoinPurchaseAction({
      prompt: trimmedPrompt,
      walletConnected: Boolean(walletConnected),
      walletAccountId,
    });
    if (memecoinPurchaseResult.handled) {
      return res.json({
        response: memecoinPurchaseResult.response,
        actionUrl: memecoinPurchaseResult.actionUrl || null,
        networkType,
      });
    }

    const memejobMarketResult = await maybeHandleMemejobMarketAction({
      prompt: trimmedPrompt,
      history,
    });
    if (memejobMarketResult.handled) {
      return res.json({
        response: memejobMarketResult.response,
        actionUrl: memejobMarketResult.actionUrl || null,
        networkType,
      });
    }

    const nftMarketResult = await maybeHandleNftMarketAction({
      prompt: trimmedPrompt,
      walletConnected: Boolean(walletConnected),
      walletAccountId,
    });
    if (nftMarketResult.handled) {
      return res.json({
        response: nftMarketResult.response,
        actionUrl: nftMarketResult.actionUrl || null,
        networkType,
      });
    }

    const projectDataResult = await maybeHandleProjectDataIntent(trimmedPrompt, networkType);
    if (projectDataResult.handled) {
      return res.json({
        response: projectDataResult.response,
        actionUrl: projectDataResult.actionUrl || null,
        networkType,
      });
    }

    if (ACTION_INTENT_REGEX.test(trimmedPrompt)) {
      const actionResult = await maybeExecuteWalletAction({
        prompt: trimmedPrompt,
        fromAccountId,
        privateKey,
        walletAccountId,
        walletConnected,
      });

      if (actionResult.handled) {
        return res.json({
          response: actionResult.response,
          actionUrl: actionResult.actionUrl || null,
          networkType,
        });
      }
    }

    const normalizedHistory = normalizeHistory(history);
    const result = await generateText({
      model: baseModel,
      system: EXECUTION_PROMPT,
      messages: [...normalizedHistory, { role: 'user', content: trimmedPrompt }],
    });

    return res.json({ response: result.text, actionUrl: null, networkType });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
