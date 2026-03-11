import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { x402Client, x402HTTPClient, decodePaymentResponseHeader, type PaymentRequired, type PaymentRequirements } from '@x402/axios';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import type { X402Config, X402ToolServiceConfig } from './economic.js';

export interface X402PreflightResult {
  provider: string;
  resourceId: string;
  payer?: string;
  quotedSpendUsd: number;
  network?: string;
  asset?: string;
  paymentRequired?: PaymentRequired;
  selectedRequirement?: PaymentRequirements;
  preview?: unknown;
  freeResponse?: unknown;
}

export interface X402ExecutionResult {
  provider: string;
  resourceId: string;
  payer?: string;
  quotedSpendUsd: number;
  actualSpendUsd: number;
  output: unknown;
  paymentResponse?: unknown;
  network?: string;
  asset?: string;
  command: string;
}

export class X402ToolError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function inferDecimals(requirement: PaymentRequirements): number | undefined {
  const extra = (requirement.extra ?? {}) as Record<string, unknown>;
  const declared = optionalNumber(extra.decimals);
  if (declared !== undefined) return declared;

  const asset = requirement.asset.toLowerCase();
  if (asset.includes('usdc') || asset.includes('usdt')) return 6;
  if (asset.includes('dai')) return 18;
  if (asset.includes('usd')) return 6;
  return undefined;
}

function amountToDecimalString(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fractional = value % divisor;
  if (fractional === 0n) return whole.toString();
  const fractionString = fractional.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionString}`;
}

function requirementToUsd(requirement: PaymentRequirements): number {
  const decimals = inferDecimals(requirement);
  if (decimals === undefined) {
    throw new X402ToolError(
      'x402_amount_unparseable',
      `Unable to infer decimals for asset '${requirement.asset}'`,
    );
  }

  return Number(amountToDecimalString(requirement.amount, decimals));
}

type ToolKey = 'intelSearch' | 'intelMarketContext';

function keyFromToolName(toolName: string): ToolKey {
  if (toolName === 'intel_search') return 'intelSearch';
  if (toolName === 'intel_market_context') return 'intelMarketContext';
  throw new X402ToolError('x402_tool_unknown', `Unknown x402 tool '${toolName}'`);
}

function makeResourceId(toolName: string, config: X402ToolServiceConfig): string {
  return `${toolName}:${config.url}`;
}

function resolveChain(network?: string) {
  if (!network) {
    return base;
  }

  switch (normalizeId(network)) {
    case 'eip155:1':
      return mainnet;
    case 'eip155:8453':
      return base;
    case 'eip155:11155111':
      return sepolia;
    case 'eip155:84532':
      return baseSepolia;
    default:
      throw new X402ToolError('x402_network_unsupported', `Unsupported x402 network '${network}'`);
  }
}

export class X402ToolRuntime {
  constructor(private readonly config: X402Config) {}

  getService(toolName: string): X402ToolServiceConfig {
    if (!this.config.enabled) {
      throw new X402ToolError('x402_disabled', 'x402 integration is disabled');
    }

    const key = keyFromToolName(toolName);
    const service = this.config.tools[key];

    if (!service.enabled || !optionalString(service.url)) {
      throw new X402ToolError('x402_service_unconfigured', `x402 service for '${toolName}' is not configured`);
    }

    return service;
  }

  async preflight(toolName: string, args: Record<string, unknown>): Promise<X402PreflightResult> {
    const service = this.getService(toolName);
    const request = this.buildRequest(toolName, service, args);
    const response = await axios.request({
      ...request,
      validateStatus: () => true,
    });

    const provider = service.provider;
    const resourceId = makeResourceId(toolName, service);

    if (response.status !== 402) {
      if (response.status < 200 || response.status >= 300) {
        throw new X402ToolError(
          'x402_preflight_failed',
          `Preflight request failed with status ${response.status}`,
        );
      }

      return {
        provider,
        resourceId,
        payer: service.payer,
        quotedSpendUsd: 0,
        freeResponse: response.data,
        preview: response.data,
      };
    }

    const paymentRequired = this.getHttpClient().getPaymentRequiredResponse(
      (name) => this.getHeader(response, name),
      response.data,
    );
    const selectedRequirement = this.selectRequirement(service, paymentRequired.accepts);
    const quotedSpendUsd = requirementToUsd(selectedRequirement);

    if (service.maxPriceUsd !== undefined && quotedSpendUsd > service.maxPriceUsd) {
      throw new X402ToolError(
        'price_above_cap',
        `Quoted x402 price $${quotedSpendUsd.toFixed(6)} exceeds cap of $${service.maxPriceUsd.toFixed(6)}`,
      );
    }

    return {
      provider,
      resourceId,
      payer: service.payer,
      quotedSpendUsd,
      network: selectedRequirement.network,
      asset: selectedRequirement.asset,
      paymentRequired,
      selectedRequirement,
      preview: response.data,
    };
  }

  async execute(toolName: string, args: Record<string, unknown>, preflight: X402PreflightResult): Promise<X402ExecutionResult> {
    const service = this.getService(toolName);
    const request = this.buildRequest(toolName, service, args);
    const provider = service.provider;
    const resourceId = makeResourceId(toolName, service);

    if (!preflight.paymentRequired || !preflight.selectedRequirement) {
      return {
        provider,
        resourceId,
        payer: service.payer,
        quotedSpendUsd: 0,
        actualSpendUsd: 0,
        output: preflight.freeResponse,
        command: `${request.method ?? 'GET'} ${service.url}`,
      };
    }

    const privateKey = process.env[this.config.evmPrivateKeyEnv]?.trim();
    if (!privateKey) {
      throw new X402ToolError(
        'x402_wallet_missing',
        `Missing ${this.config.evmPrivateKeyEnv} for x402 settlement`,
      );
    }

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const chain = resolveChain(preflight.network);
    const publicClient = createPublicClient({
      chain,
      transport: http(),
    });
    const signer = toClientEvmSigner(account, publicClient);
    const client = new x402Client().register('eip155:*', new ExactEvmScheme(signer));
    const httpClient = new x402HTTPClient(client);
    const paymentRequired = {
      ...preflight.paymentRequired,
      accepts: [preflight.selectedRequirement],
    };
    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    const settled = await axios.request({
      ...request,
      headers: {
        ...(request.headers ?? {}),
        ...paymentHeaders,
      },
      validateStatus: () => true,
    });

    if (settled.status < 200 || settled.status >= 300) {
      throw new X402ToolError(
        'x402_payment_failed',
        `Paid request failed with status ${settled.status}`,
      );
    }

    const rawPaymentResponse = this.getHeader(settled, 'payment-response');
    const paymentResponse = rawPaymentResponse ? decodePaymentResponseHeader(rawPaymentResponse) : undefined;

    return {
      provider,
      resourceId,
      quotedSpendUsd: preflight.quotedSpendUsd,
      actualSpendUsd: preflight.quotedSpendUsd,
      output: settled.data,
      paymentResponse,
      payer: optionalString((paymentResponse as Record<string, unknown> | undefined)?.payer) ?? preflight.payer,
      network: preflight.network,
      asset: preflight.asset,
      command: `${request.method ?? 'GET'} ${service.url}`,
    };
  }

  private buildRequest(toolName: string, service: X402ToolServiceConfig, args: Record<string, unknown>): AxiosRequestConfig {
    const method = service.method;

    if (toolName === 'intel_search') {
      const query = optionalString(args.query);
      if (!query) {
        throw new X402ToolError('x402_invalid_args', "Missing 'query' for intel_search");
      }
      const limit = optionalNumber(args.limit);
      const params: Record<string, unknown> = {
        [service.queryParam]: query,
      };
      if (limit !== undefined) params.limit = limit;
      return {
        method,
        url: service.url,
        params: method === 'GET' ? params : undefined,
        data: method === 'POST' ? params : undefined,
      };
    }

    const payload: Record<string, unknown> = {};
    const market = optionalString(args.market);
    const event = optionalString(args.event);
    const token = optionalString(args.token);
    if (market) payload[service.marketParam] = market;
    if (event) payload[service.eventParam] = event;
    if (token) payload[service.tokenParam] = token;

    return {
      method,
      url: service.url,
      params: method === 'GET' ? payload : undefined,
      data: method === 'POST' ? payload : undefined,
    };
  }

  private selectRequirement(service: X402ToolServiceConfig, requirements: PaymentRequirements[]): PaymentRequirements {
    const networks = new Set(service.allowedNetworks.map(normalizeId));
    const assets = new Set(service.allowedAssets.map(normalizeId));

    const allowed = requirements.filter((requirement) => {
      const networkOk = networks.size === 0 || networks.has(normalizeId(requirement.network));
      const assetOk = assets.size === 0 || assets.has(normalizeId(requirement.asset));
      return networkOk && assetOk;
    });

    if (allowed.length === 0) {
      throw new X402ToolError('x402_payment_option_unavailable', 'No compatible x402 payment option is available');
    }

    return [...allowed].sort((left, right) => requirementToUsd(left) - requirementToUsd(right))[0]!;
  }

  private getHeader(response: AxiosResponse, name: string): string | undefined {
    const value = response.headers[name] ?? response.headers[name.toLowerCase()];
    return typeof value === 'string' ? value : undefined;
  }

  private getHttpClient(): x402HTTPClient {
    return new x402HTTPClient(new x402Client());
  }
}
