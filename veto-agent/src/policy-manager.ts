import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  createReplSessionContext,
  findRuleById,
  generatePolicyFromPrompt,
  getRuleSourceInfo,
  listRuleSummaries,
  loadSessionRulesFromFile,
  validateGeneratedYaml,
  type ReplSessionContext,
} from 'veto-sdk/cli';
import type { Rule, RuleCondition } from 'veto-sdk/rules';

type RuleConditionInput = RuleCondition & { reference?: string };

export interface PolicySummary {
  id: string;
  name: string;
  action: Rule['action'];
  tools: string[];
  source: string;
}

export interface RequiredPolicyContexts {
  market: boolean;
  budget: boolean;
  portfolio: boolean;
}

export interface PolicyCreateInput {
  prompt: string;
  toolName?: string;
}

export interface PolicyCreateResult {
  overlayPath: string;
  ruleIds: string[];
  warnings: string[];
}

export interface PolicyTightenInput {
  ruleId: string;
  newCondition: RuleConditionInput;
}

export interface PolicyEditRequestInput {
  ruleId: string;
  changes: Record<string, unknown>;
}

export interface PolicyManagerOptions {
  projectDir: string;
  vetoConfigDir: string;
  sessionId: string;
  overlayDir: string;
  reloadRules?: () => Promise<void>;
  createReplSessionContext?: typeof createReplSessionContext;
  generatePolicyFromPrompt?: typeof generatePolicyFromPrompt;
  validateGeneratedYaml?: typeof validateGeneratedYaml;
  loadSessionRulesFromFile?: typeof loadSessionRulesFromFile;
  listRuleSummaries?: typeof listRuleSummaries;
  findRuleById?: typeof findRuleById;
  getRuleSourceInfo?: typeof getRuleSourceInfo;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function sanitizeOverlayDir(overlayDir: string): string {
  const trimmed = overlayDir.trim();
  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') {
    return 'rules';
  }

  return /^[a-zA-Z0-9._-]+$/.test(trimmed) ? trimmed : 'rules';
}

function toRuleArray(value: unknown): Rule[] {
  return Array.isArray(value) ? value as Rule[] : [];
}

function scanConditionPath(path: string | undefined, required: RequiredPolicyContexts): void {
  if (!path) {
    return;
  }

  if (path.startsWith('market.')) {
    required.market = true;
  }
  if (path.startsWith('budget.')) {
    required.budget = true;
  }
  if (path.startsWith('portfolio.')) {
    required.portfolio = true;
  }
}

function conditionReference(condition: RuleCondition): string | undefined {
  const reference = (condition as Record<string, unknown>).reference;
  return typeof reference === 'string' && reference.trim().length > 0 ? reference : undefined;
}

function mergeSessionRules(existingRules: Rule[], newRules: Rule[]): Rule[] {
  const merged = [...existingRules];
  const indexById = new Map<string, number>();

  for (let i = 0; i < merged.length; i++) {
    indexById.set(merged[i].id, i);
  }

  for (const rule of newRules) {
    const existingIndex = indexById.get(rule.id);
    if (existingIndex === undefined) {
      indexById.set(rule.id, merged.length);
      merged.push(rule);
      continue;
    }

    merged[existingIndex] = rule;
  }

  return merged;
}

export class PolicyManager {
  private context: ReplSessionContext | null = null;
  private readonly projectDir: string;
  private readonly vetoConfigDir: string;
  private readonly overlayPath: string;
  private readonly reloadRules?: () => Promise<void>;
  private readonly createContextImpl: typeof createReplSessionContext;
  private readonly generateImpl: typeof generatePolicyFromPrompt;
  private readonly validateImpl: typeof validateGeneratedYaml;
  private readonly loadSessionRulesImpl: typeof loadSessionRulesFromFile;
  private readonly findRuleByIdImpl: typeof findRuleById;
  private readonly getRuleSourceInfoImpl: typeof getRuleSourceInfo;

  constructor(options: PolicyManagerOptions) {
    this.projectDir = resolve(options.projectDir);
    this.vetoConfigDir = resolve(options.vetoConfigDir);
    const overlayDir = sanitizeOverlayDir(options.overlayDir);
    this.overlayPath = join(
      this.vetoConfigDir,
      overlayDir,
      `session-${sanitizeSessionId(options.sessionId)}.generated.yaml`,
    );
    this.reloadRules = options.reloadRules;
    this.createContextImpl = options.createReplSessionContext ?? createReplSessionContext;
    this.generateImpl = options.generatePolicyFromPrompt ?? generatePolicyFromPrompt;
    this.validateImpl = options.validateGeneratedYaml ?? validateGeneratedYaml;
    this.loadSessionRulesImpl = options.loadSessionRulesFromFile ?? loadSessionRulesFromFile;
    this.findRuleByIdImpl = options.findRuleById ?? findRuleById;
    this.getRuleSourceInfoImpl = options.getRuleSourceInfo ?? getRuleSourceInfo;
  }

  async create(input: PolicyCreateInput): Promise<PolicyCreateResult> {
    const context = await this.loadContext(true);
    const tools = input.toolName
      ? context.discoveredTools.filter((tool) => tool.name === input.toolName)
      : context.discoveredTools;

    if (input.toolName && tools.length === 0) {
      throw new Error(`Tool '${input.toolName}' not found in workspace discovery`);
    }

    const generated = await this.generateImpl({
      prompt: input.prompt,
      projectDir: this.projectDir,
      rulesDirectory: context.rulesDir,
      tools,
      existingRules: context.allRules,
      allowTemplateFallback: true,
    });

    const parsed = this.validateImpl(generated.yaml);
    const createdRules = toRuleArray(parsed.rules);
    const mergedRules = mergeSessionRules(context.sessionRules, createdRules);
    await this.persistSessionRules(mergedRules);

    return {
      overlayPath: this.overlayPath,
      ruleIds: createdRules.map((rule) => rule.id),
      warnings: generated.warnings,
    };
  }

  async list(): Promise<PolicySummary[]> {
    const context = await this.loadContext();
    if (context.sessionRules.length === 0) {
      return [];
    }

    return context.sessionRules.map((rule) => {
      const sourceInfo = this.getRuleSourceInfoImpl(context, rule.id);
      return {
        id: rule.id,
        name: rule.name,
        action: rule.action,
        tools: rule.tools ?? [],
        source: sourceInfo
          ? `${sourceInfo.source}${sourceInfo.line ? `:${sourceInfo.line}` : ''}`
          : basename(this.overlayPath),
      };
    });
  }

  async tighten(input: PolicyTightenInput): Promise<{ ruleId: string; overlayPath: string }> {
    const context = await this.loadContext();
    const existingIndex = context.sessionRules.findIndex((rule) => rule.id === input.ruleId);
    if (existingIndex === -1) {
      throw new Error(`Session rule '${input.ruleId}' not found`);
    }

    const existingRule = context.sessionRules[existingIndex];
    if (existingRule.action !== 'allow') {
      throw new Error('Only allow rules can be tightened automatically; use policy_request_edit for block or require_approval rules.');
    }
    if (existingRule.condition_groups && existingRule.condition_groups.length > 0) {
      throw new Error('Tightening rules with condition groups is not supported');
    }

    const updatedRule: Rule = {
      ...existingRule,
      conditions: [...(existingRule.conditions ?? []), input.newCondition],
    };

    const updatedRules = [...context.sessionRules];
    updatedRules[existingIndex] = updatedRule;
    await this.persistSessionRules(updatedRules);

    return {
      ruleId: input.ruleId,
      overlayPath: this.overlayPath,
    };
  }

  async requestEdit(input: PolicyEditRequestInput): Promise<{
    status: 'pending_approval';
    ruleId: string;
    message: string;
    changes: Record<string, unknown>;
  }> {
    const context = await this.loadContext();
    const rule = this.findRuleByIdImpl(context, input.ruleId);
    if (!rule) {
      throw new Error(`Rule '${input.ruleId}' not found`);
    }

    return {
      status: 'pending_approval',
      ruleId: rule.id,
      message: 'Requested edit may loosen an active policy and requires manual approval.',
      changes: input.changes,
    };
  }

  async getRequiredContexts(): Promise<RequiredPolicyContexts> {
    const context = await this.loadContext();
    const required: RequiredPolicyContexts = {
      market: false,
      budget: false,
      portfolio: false,
    };

    for (const rule of context.sessionRules) {
      for (const condition of rule.conditions ?? []) {
        scanConditionPath(condition.field, required);
        scanConditionPath(conditionReference(condition), required);
      }

      for (const group of rule.condition_groups ?? []) {
        for (const condition of group) {
          scanConditionPath(condition.field, required);
          scanConditionPath(conditionReference(condition), required);
        }
      }
    }

    return required;
  }

  private async loadContext(forceReload = false): Promise<ReplSessionContext> {
    if (this.context && !forceReload) {
      return this.context;
    }

    const context = await this.createContextImpl(this.projectDir);
    if (existsSync(this.overlayPath)) {
      await this.loadSessionRulesImpl(context, this.overlayPath);
    }

    this.context = context;
    return context;
  }

  private async persistSessionRules(rules: Rule[]): Promise<void> {
    mkdirSync(join(this.vetoConfigDir, basename(join(this.overlayPath, '..'))), { recursive: true });
    const yaml = stringify({
      version: '1.0',
      name: `session-${sanitizeSessionId(basename(this.overlayPath, '.generated.yaml'))}`,
      rules,
    }, {
      lineWidth: 120,
    });

    this.validateImpl(yaml);
    mkdirSync(join(this.overlayPath, '..'), { recursive: true });
    writeFileSync(this.overlayPath, yaml, 'utf-8');
    await this.loadContext(true);

    if (this.reloadRules) {
      await this.reloadRules();
    }
  }
}
