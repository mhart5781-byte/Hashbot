import { HashConnect, HashConnectConnectionState } from 'https://esm.sh/hashconnect@3.0.12';
import { LedgerId, AccountId, Hbar, TransferTransaction } from 'https://esm.sh/@hashgraph/sdk';

const conversationHistory = [];
const input = document.getElementById('chatInput');
const submitButton = document.getElementById('chatSubmit');
const starterChips = document.querySelectorAll('.starter-chip');
const connectWalletBtn = document.getElementById('connectWalletBtn');
const openPairingBtn = document.getElementById('openPairingBtn');
const walletStatusEl = document.getElementById('walletStatus');

let hashconnect;
let pairingData = null;
let connectedAccountId = null;
let clientConfig = null;
let pairingUri = '';
let connectedNetworkType = 'testnet';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

function appendMessage(role, text) {
  const messages = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = `<span>${escapeHtml(text)}</span>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function normalizeNetworkType(raw) {
  return String(raw || '').toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
}

function getConfiguredNetworkType() {
  return normalizeNetworkType(clientConfig?.network);
}

// Update the wallet status to dynamically display Testnet or Mainnet
function updateWalletStatus(networkType = connectedNetworkType) {
  const safeNetworkType = normalizeNetworkType(networkType);
  if (connectedAccountId) {
    walletStatusEl.textContent = `Connected: ${connectedAccountId} (${safeNetworkType === 'mainnet' ? 'Mainnet' : 'Testnet'})`;
    walletStatusEl.classList.add('connected');
    connectWalletBtn.textContent = 'Disconnect Wallet';
  } else {
    walletStatusEl.textContent = 'Wallet not connected';
    walletStatusEl.classList.remove('connected');
    connectWalletBtn.textContent = 'Connect HashPack';
  }
}

function getFallbackPairingUrl() {
  if (!pairingUri) {
    return null;
  }

  const encoded = encodeURIComponent(pairingUri);
  return `https://wallet.hashpack.app/pair?uri=${encoded}`;
}

function parseTransferPrompt(prompt) {
  const amountMatch = prompt.match(/(\d+(?:\.\d+)?)\s*hbar/i);
  const toMatch = prompt.match(/\bto\s+(?:account\s*)?(\d+\.\d+\.\d+|\d+)\b/i);

  if (!amountMatch || !toMatch) {
    return null;
  }

  const toValue = toMatch[1];
  const toAccountId = toValue.includes('.') ? toValue : `0.0.${toValue}`;
  return {
    amount: Number(amountMatch[1]),
    toAccountId,
  };
}

function isTransferIntent(prompt) {
  return /\b(send|transfer|pay)\b.*\bhbar\b/i.test(prompt);
}

async function initHashConnect() {
  if (!clientConfig) {
    const configResponse = await fetch('/client-config');
    clientConfig = await configResponse.json();
  }

  const projectId = clientConfig?.hashconnectProjectId;
  if (!projectId) {
    throw new Error('Missing HASHCONNECT_PROJECT_ID on server. Add it to your .env, restart server, then reconnect.');
  }

  const appMetadata = {
    name: 'Hedera AI Agent',
    description: 'Chat agent with wallet-gated HBAR transfers',
    icons: ['https://hedera.com/favicon.ico'],
    url: window.location.origin,
  };

  hashconnect = new HashConnect(LedgerId.TESTNET, projectId, appMetadata, false);

  hashconnect.pairingEvent.on((session) => {
    pairingData = session;
    connectedAccountId = session?.accountIds?.[0] || null;
    connectedNetworkType = normalizeNetworkType(session?.network || getConfiguredNetworkType());
    updateWalletStatus(connectedNetworkType);
    if (connectedAccountId) {
      appendMessage('agent', `HashPack connected: ${connectedAccountId}. You can now send HBAR from this wallet.`);
    }
  });

  hashconnect.disconnectionEvent.on(() => {
    pairingData = null;
    connectedAccountId = null;
    connectedNetworkType = getConfiguredNetworkType();
    updateWalletStatus();
  });

  hashconnect.connectionStatusChangeEvent.on((status) => {
    if (status === HashConnectConnectionState.Disconnected && !connectedAccountId) {
      updateWalletStatus();
    }
  });

  await hashconnect.init();
  pairingUri = hashconnect.hcData?.pairingString || '';

  const existingPairing = hashconnect.hcData?.pairingData?.[0];
  if (existingPairing) {
    pairingData = existingPairing;
    connectedAccountId = existingPairing?.accountIds?.[0] || null;
    connectedNetworkType = normalizeNetworkType(existingPairing?.network || getConfiguredNetworkType());
  }

  updateWalletStatus(connectedNetworkType);
}

async function executeWalletTransfer(parsedTransfer) {
  if (!connectedAccountId) {
    throw new Error('Connect your HashPack wallet before sending HBAR.');
  }

  const signer = hashconnect.getSigner(AccountId.fromString(connectedAccountId));

  const tx = await new TransferTransaction()
    .addHbarTransfer(connectedAccountId, new Hbar(-parsedTransfer.amount))
    .addHbarTransfer(parsedTransfer.toAccountId, new Hbar(parsedTransfer.amount))
    .freezeWithSigner(signer);

  const response = await tx.executeWithSigner(signer);
  const receipt = await response.getReceiptWithSigner(signer);

  return {
    status: receipt.status.toString(),
    transactionId: String(response.transactionId),
  };
}

appendMessage(
  'agent',
  'Ask me anything about Hedera. To send HBAR or execute directed NFT/memecoin purchase flows, connect your HashPack wallet first.'
);

starterChips.forEach((chip) => {
  chip.addEventListener('click', function () {
    input.value = chip.dataset.prompt || '';
    input.focus();
  });
});

connectWalletBtn.addEventListener('click', async () => {
  try {
    if (!hashconnect) {
      await initHashConnect();
    }

    if (connectedAccountId) {
      hashconnect.disconnect();
      pairingData = null;
      connectedAccountId = null;
      connectedNetworkType = getConfiguredNetworkType();
      updateWalletStatus();
      return;
    }

    hashconnect.openPairingModal();
    pairingUri = hashconnect.hcData?.pairingString || pairingUri;
  } catch (err) {
    appendMessage('agent', `Wallet connection failed: ${err.message}`);
  }
});

if (openPairingBtn) {
  openPairingBtn.addEventListener('click', async () => {
    try {
      if (!hashconnect) {
        await initHashConnect();
      }

      pairingUri = hashconnect.hcData?.pairingString || pairingUri;
      if (!pairingUri) {
        // Kick off pairing generation if it hasn't been created yet.
        hashconnect.openPairingModal();
        await new Promise((resolve) => setTimeout(resolve, 250));
        pairingUri = hashconnect.hcData?.pairingString || pairingUri;
      }

      const fallbackUrl = getFallbackPairingUrl();
      if (!fallbackUrl) {
        appendMessage('agent', 'Pairing URI is still not ready. If this persists, refresh once and try Open HashPack Pairing again.');
        return;
      }

      window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      appendMessage('agent', 'Opened HashPack pairing fallback link in a new tab. Approve pairing there, then return here.');
    } catch (err) {
      appendMessage('agent', `Could not open HashPack pairing fallback: ${err.message}`);
    }
  });
}

document.getElementById('chatForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const prompt = input.value.trim();
  if (!prompt) return;

  submitButton.disabled = true;
  appendMessage('user', prompt);
  input.value = '';

  const thinkingDiv = appendMessage('agent', 'Thinking...');

  try {
    if (isTransferIntent(prompt)) {
      const parsed = parseTransferPrompt(prompt);
      if (!parsed) {
        thinkingDiv.innerHTML = '<span>Please include amount and destination account. Example: send 1.25 HBAR to account 0.0.12345</span>';
      } else if (!connectedAccountId) {
        thinkingDiv.innerHTML = '<span>Please connect your HashPack wallet first. Transfers are wallet-gated.</span>';
      } else {
        const transfer = await executeWalletTransfer(parsed);
        const reply = `Transaction sent from ${connectedAccountId}. Status: ${transfer.status}. TxID: ${transfer.transactionId}.`;
        thinkingDiv.innerHTML = `<span>${escapeHtml(reply)}</span>`;
        conversationHistory.push({ role: 'user', content: prompt });
        conversationHistory.push({ role: 'assistant', content: reply });
      }
    } else {
      const res = await fetch('/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          history: conversationHistory,
          walletAccountId: connectedAccountId,
          walletNetworkType: connectedNetworkType,
          walletConnected: Boolean(connectedAccountId),
        }),
      });
      const data = await res.json();
      const reply = data.response || data.error;
      thinkingDiv.innerHTML = `<span>${escapeHtml(reply)}</span>`;

      if (data.actionUrl) {
        window.open(data.actionUrl, '_blank', 'noopener,noreferrer');
      }

      if (data.response) {
        conversationHistory.push({ role: 'user', content: prompt });
        conversationHistory.push({ role: 'assistant', content: reply });
      }
    }
  } catch (err) {
    thinkingDiv.innerHTML = `<span>Error: ${escapeHtml(err.message)}</span>`;
  } finally {
    submitButton.disabled = false;
    input.focus();
  }

  document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
});

initHashConnect().catch((err) => {
  appendMessage('agent', `HashPack not ready yet: ${err.message}`);
});


