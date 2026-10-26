import type {
  GroupAccessAccessLevel,
  GroupAccessGroup,
  GroupAccessMemberRule,
  GroupAccessProjectScope,
} from "./accessApi";

export type EffectiveAccessSource = "personal" | "department" | "none";

export type EffectiveAccessRule = {
  source: EffectiveAccessSource;
  projectScope: GroupAccessProjectScope;
  accessLevel: GroupAccessAccessLevel;
  projectIds: string[];
  updatedAt: string | null;
};

export function memberRuleOf(group: GroupAccessGroup, userId: string): GroupAccessMemberRule | null {
  return group.memberRules.find((rule) => rule.userId === userId) ?? null;
}

export function groupRuleAppliesToMember(group: GroupAccessGroup, userId: string): boolean {
  const rule = group.rule;
  if (rule === null) return false;
  return rule.memberScope === "all" || rule.memberUserIds.includes(userId);
}

export function effectiveMemberAccess(group: GroupAccessGroup, userId: string): EffectiveAccessRule {
  const personal = memberRuleOf(group, userId);
  if (personal !== null) {
    return {
      source: "personal",
      projectScope: personal.projectScope,
      accessLevel: personal.accessLevel,
      projectIds: personal.projectIds,
      updatedAt: personal.updatedAt,
    };
  }
  const rule = group.rule;
  if (rule !== null && groupRuleAppliesToMember(group, userId)) {
    return {
      source: "department",
      projectScope: rule.projectScope,
      accessLevel: rule.accessLevel,
      projectIds: rule.projectIds,
      updatedAt: rule.updatedAt,
    };
  }
  return { source: "none", projectScope: "none", accessLevel: "view", projectIds: [], updatedAt: null };
}

export function effectiveAccessRule(
  personal: GroupAccessMemberRule | null,
  groupRule: GroupAccessGroup["rule"],
  userId: string,
): EffectiveAccessRule {
  if (personal !== null) {
    return {
      source: "personal",
      projectScope: personal.projectScope,
      accessLevel: personal.accessLevel,
      projectIds: personal.projectIds,
      updatedAt: personal.updatedAt,
    };
  }
  if (groupRule !== null && (groupRule.memberScope === "all" || groupRule.memberUserIds.includes(userId))) {
    return {
      source: "department",
      projectScope: groupRule.projectScope,
      accessLevel: groupRule.accessLevel,
      projectIds: groupRule.projectIds,
      updatedAt: groupRule.updatedAt,
    };
  }
  return { source: "none", projectScope: "none", accessLevel: "view", projectIds: [], updatedAt: null };
}
