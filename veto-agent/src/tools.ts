import type { PolicyProfile } from './types.js';

export interface ToolSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface CommandBuildResult {
  argv: string[];
  guardArgs: Record<string, unknown>;
  notes?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  mutating: boolean;
  internal?: boolean;
  inputSchema: ToolSchema;
  build(args: Record<string, unknown>): CommandBuildResult;
}

function assertAllowedFields(args: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(args)) {
    if (!allowedSet.has(key)) {
      throw new Error(`Unexpected argument '${key}'`);
    }
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid '${field}': expected non-empty string`);
  }
  return value.trim();
}

function asNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid '${field}': expected number`);
  }
  return parsed;
}

function asPositiveNumber(value: unknown, field: string): number {
  const parsed = asNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`Invalid '${field}': expected positive number`);
  }
  return parsed;
}

function asBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid '${field}': expected boolean`);
  }
  return value;
}

function maybePositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return asPositiveNumber(value, field);
}

function maybeBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return asBool(value, field);
}

function maybeString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field);
}

function asSide(value: unknown, field: string): 'buy' | 'sell' {
  const side = asString(value, field).toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`Invalid '${field}': expected 'buy' or 'sell'`);
  }
  return side;
}

function asOrderType(value: string): 'GTC' | 'FOK' | 'GTD' | 'FAK' {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'GTC' || normalized === 'FOK' || normalized === 'GTD' || normalized === 'FAK') {
    return normalized;
  }
  throw new Error("Invalid 'orderType': expected GTC|FOK|GTD|FAK");
}

function toFlagBool(value: boolean): string {
  return value ? 'true' : 'false';
}

const READ_ONLY_TOOLS: ToolSpec[] = [
  {
    name: 'markets_list',
    description: 'List markets with optional filters.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', minimum: 1 },
        active: { type: 'boolean' },
        closed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['limit', 'active', 'closed']);
      const limit = maybePositiveNumber(args.limit, 'limit');
      const active = maybeBool(args.active, 'active');
      const closed = maybeBool(args.closed, 'closed');
      const argv = ['markets', 'list'];
      if (limit !== undefined) argv.push('--limit', String(limit));
      if (active !== undefined) argv.push('--active', toFlagBool(active));
      if (closed !== undefined) argv.push('--closed', toFlagBool(closed));
      return { argv, guardArgs: { ...args } };
    },
  },
  {
    name: 'markets_search',
    description: 'Search markets by free text query.',
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['query', 'limit']);
      const query = asString(args.query, 'query');
      const limit = maybePositiveNumber(args.limit, 'limit');
      const argv = ['markets', 'search', query];
      if (limit !== undefined) argv.push('--limit', String(limit));
      return { argv, guardArgs: { query, limit } };
    },
  },
  {
    name: 'markets_get',
    description: 'Get market details by id or slug.',
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['market'],
      properties: {
        market: { type: 'string' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['market']);
      const market = asString(args.market, 'market');
      return {
        argv: ['markets', 'get', market],
        guardArgs: { market },
      };
    },
  },
  {
    name: 'clob_book',
    description: 'Get order book for token id.',
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['token'],
      properties: {
        token: { type: 'string' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['token']);
      const token = asString(args.token, 'token');
      return {
        argv: ['clob', 'book', token],
        guardArgs: { token },
      };
    },
  },
  {
    name: 'clob_midpoint',
    description: 'Get midpoint price for token id.',
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['token'],
      properties: {
        token: { type: 'string' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['token']);
      const token = asString(args.token, 'token');
      return {
        argv: ['clob', 'midpoint', token],
        guardArgs: { token },
      };
    },
  },
  {
    name: 'clob_price',
    description: 'Get clob price for token/side.',
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['token', 'side'],
      properties: {
        token: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['token', 'side']);
      const token = asString(args.token, 'token');
      const side = asSide(args.side, 'side');
      return {
        argv: ['clob', 'price', token, '--side', side],
        guardArgs: { token, side },
      };
    },
  },
  {
    name: 'portfolio_positions',
    description: 'Get public portfolio positions for wallet address.',
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['address']);
      const address = asString(args.address, 'address');
      return {
        argv: ['data', 'positions', address],
        guardArgs: { address },
      };
    },
  },
];

const MUTATING_TOOLS: ToolSpec[] = [
  {
    name: 'order_create_limit',
    description: 'Create a limit order on CLOB.',
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['token', 'side', 'price', 'size'],
      properties: {
        token: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        price: { type: 'number', minimum: 0 },
        size: { type: 'number', minimum: 0 },
        postOnly: { type: 'boolean' },
        orderType: { type: 'string', enum: ['GTC', 'FOK', 'GTD', 'FAK'] },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['token', 'side', 'price', 'size', 'postOnly', 'orderType']);
      const token = asString(args.token, 'token');
      const side = asSide(args.side, 'side');
      const price = asPositiveNumber(args.price, 'price');
      const size = asPositiveNumber(args.size, 'size');
      const postOnly = maybeBool(args.postOnly, 'postOnly');
      const orderType = maybeString(args.orderType, 'orderType');

      const argv = [
        'clob',
        'create-order',
        '--token', token,
        '--side', side,
        '--price', String(price),
        '--size', String(size),
      ];

      if (postOnly !== undefined) {
        argv.push('--post-only', toFlagBool(postOnly));
      }

      if (orderType !== undefined) {
        argv.push('--order-type', asOrderType(orderType));
      }

      const amountUsd = Number((price * size).toFixed(8));

      return {
        argv,
        guardArgs: {
          token,
          side,
          price,
          size,
          amount_usd: amountUsd,
          postOnly,
          orderType,
        },
      };
    },
  },
  {
    name: 'order_market',
    description: 'Create a market order on CLOB.',
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['token', 'side', 'amount'],
      properties: {
        token: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        amount: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['token', 'side', 'amount']);
      const token = asString(args.token, 'token');
      const side = asSide(args.side, 'side');
      const amount = asPositiveNumber(args.amount, 'amount');

      return {
        argv: [
          'clob',
          'market-order',
          '--token', token,
          '--side', side,
          '--amount', String(amount),
        ],
        guardArgs: {
          token,
          side,
          amount,
          amount_usd: amount,
        },
      };
    },
  },
  {
    name: 'order_cancel',
    description: 'Cancel a specific order.',
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['orderId'],
      properties: {
        orderId: { type: 'string' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['orderId']);
      const orderId = asString(args.orderId, 'orderId');
      return {
        argv: ['clob', 'cancel', orderId],
        guardArgs: { orderId },
      };
    },
  },
  {
    name: 'order_cancel_all',
    description: 'Cancel all open orders.',
    mutating: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, []);
      return {
        argv: ['clob', 'cancel-all'],
        guardArgs: {},
      };
    },
  },
  {
    name: 'approve_set',
    description: 'Set Polymarket contract approvals.',
    mutating: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, []);
      return {
        argv: ['approve', 'set'],
        guardArgs: {},
      };
    },
  },
  {
    name: 'ctf_split',
    description: 'Split USDC into conditional tokens.',
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['condition', 'amount'],
      properties: {
        condition: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['condition', 'amount']);
      const condition = asString(args.condition, 'condition');
      const amount = asPositiveNumber(args.amount, 'amount');
      return {
        argv: ['ctf', 'split', '--condition', condition, '--amount', String(amount)],
        guardArgs: {
          condition,
          amount,
          amount_usd: amount,
        },
      };
    },
  },
  {
    name: 'ctf_merge',
    description: 'Merge conditional tokens back to USDC.',
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['condition', 'amount'],
      properties: {
        condition: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['condition', 'amount']);
      const condition = asString(args.condition, 'condition');
      const amount = asPositiveNumber(args.amount, 'amount');
      return {
        argv: ['ctf', 'merge', '--condition', condition, '--amount', String(amount)],
        guardArgs: {
          condition,
          amount,
          amount_usd: amount,
        },
      };
    },
  },
  {
    name: 'ctf_redeem',
    description: 'Redeem winning conditional tokens.',
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['condition'],
      properties: {
        condition: { type: 'string' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['condition']);
      const condition = asString(args.condition, 'condition');
      return {
        argv: ['ctf', 'redeem', '--condition', condition],
        guardArgs: { condition },
      };
    },
  },
];

const INTERNAL_TOOLS: ToolSpec[] = [
  {
    name: 'audit_query',
    description: 'Query the audit log for recent decisions and trade history.',
    mutating: false,
    internal: true,
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO timestamp to filter entries after' },
        agentId: { type: 'string' },
        toolName: { type: 'string' },
        limit: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['since', 'agentId', 'toolName', 'limit']);
      return { argv: [], guardArgs: { ...args } };
    },
  },
  {
    name: 'pnl_snapshot',
    description: 'Get a snapshot of all positions with realized and unrealized P&L.',
    mutating: false,
    internal: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, []);
      return { argv: [], guardArgs: {} };
    },
  },
  {
    name: 'pnl_position',
    description: 'Get position details for a specific token.',
    mutating: false,
    internal: true,
    inputSchema: {
      type: 'object',
      required: ['token'],
      properties: {
        token: { type: 'string' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['token']);
      const token = asString(args.token, 'token');
      return { argv: [], guardArgs: { token } };
    },
  },
  {
    name: 'circuit_breaker_status',
    description: 'Get the current circuit breaker state and statistics.',
    mutating: false,
    internal: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, []);
      return { argv: [], guardArgs: {} };
    },
  },
  {
    name: 'compliance_report',
    description: 'Generate a compliance report from the audit log.',
    mutating: false,
    internal: true,
    inputSchema: {
      type: 'object',
      required: ['format'],
      properties: {
        format: { type: 'string', enum: ['csv', 'json'] },
        period: { type: 'string', enum: ['day', 'week', 'month'] },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
        outputPath: { type: 'string' },
      },
      additionalProperties: false,
    },
    build(args) {
      assertAllowedFields(args, ['format', 'period', 'startDate', 'endDate', 'outputPath']);
      const format = asString(args.format, 'format');
      if (format !== 'csv' && format !== 'json') {
        throw new Error("Invalid 'format': expected csv|json");
      }
      return { argv: [], guardArgs: { ...args } };
    },
  },
];

export const TOOL_SPECS: ToolSpec[] = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS, ...INTERNAL_TOOLS];

const TOOL_MAP = new Map(TOOL_SPECS.map((tool) => [tool.name, tool]));

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_MAP.get(name);
}

export function listTools(): ToolSpec[] {
  return TOOL_SPECS;
}

export function profileAgentId(profile: PolicyProfile): string {
  return `profile/${profile}`;
}
