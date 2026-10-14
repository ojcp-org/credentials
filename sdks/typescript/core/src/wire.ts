/**
 * The OJCP wire shapes these libraries consume, parsed once at the boundary.
 * Schemas are permissive about members they don't use (OJCP is extensible) and
 * strict about the ones they do.
 */
import { z } from "zod";

export const TOOLS = [
  "search_jobs",
  "get_job_detail",
  "get_employer_context",
  "begin_application",
  "submit_application",
  "check_application_status",
] as const;
export const Tool = z.enum(TOOLS);
export type Tool = z.infer<typeof Tool>;

export const CONSENT_SCOPES = [
  "search_personalization",
  "fit_scoring",
  "application_prefill",
  "full_profile",
] as const;
export const ConsentScope = z.enum(CONSENT_SCOPES);
export type ConsentScope = z.infer<typeof ConsentScope>;

export const REMOTE_POLICIES = ["on_site", "hybrid", "remote", "flexible"] as const;

/** RFC 0009 §1.1 */
export const CategoryCode = z.looseObject({
  "@type": z.literal("CategoryCode").optional(),
  codeValue: z.string(),
  inCodeSet: z.string(),
  name: z.string().optional(),
});
export type CategoryCode = z.infer<typeof CategoryCode>;

/** RFC 0009 §2: codes only count when they are codes. */
export const Place = z.looseObject({
  "@type": z.literal("Place").optional(),
  address: z
    .looseObject({
      addressCountry: z.string().optional(),
      addressRegion: z.string().optional(),
      addressLocality: z.string().optional(),
    })
    .optional(),
});
export type Place = z.infer<typeof Place>;

export const BaseSalary = z.looseObject({
  currency: z.string().optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  unitText: z.string().optional(),
});

/** The JobPosting members standing-mandate scope reads (RFC 0008 §2.2). */
export const JobPostingFacts = z.looseObject({
  ojcp_id: z.string(),
  occupationalCategory: z.array(z.unknown()).optional(),
  jobLocation: z.union([Place, z.array(Place)]).optional(),
  remote_policy: z.string().optional(),
  employmentType: z.string().optional(),
  experienceLevel: z.string().optional(),
  baseSalary: BaseSalary.optional(),
  employer: z.looseObject({ ojcp_employer_id: z.string().optional() }).optional(),
});
export type JobPostingFacts = z.infer<typeof JobPostingFacts>;

/** RFC 0009 §3.2 */
export const BindingActionDocument = z.looseObject({
  uri: z.url({ protocol: /^https$/ }),
  digest: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  media_type: z.string(),
  title: z.string().optional(),
  standalone: z.boolean().optional(),
});
export const BindingAction = z.looseObject({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  statement: z.string(),
  required: z.boolean(),
  question_ids: z.array(z.string()).optional(),
  fields: z.array(z.string()).optional(),
  documents: z.array(BindingActionDocument).optional(),
});
export type BindingAction = z.infer<typeof BindingAction>;
export const BindingActions = z.array(BindingAction);

export const AgentDeclaration = z.looseObject({
  agent_id: z.string(),
  agent_version: z.string().optional(),
  acting_on_behalf_of: z.string().optional(),
  interaction_mode: z.enum(["assisted", "supervised", "autonomous"]).optional(),
  user_consent_token: z.string().optional(),
  user_mandate: z.string().max(16384).optional(),
});
export type AgentDeclaration = z.infer<typeof AgentDeclaration>;

/** RFC 0008 §9: `auth.user_mandates` in the Job Manifest. */
export const UserMandatesPolicy = z.looseObject({
  types: z.array(z.enum(["action", "standing"])),
  required_for: z.array(z.string()).default([]),
  action_mandate_required_for: z.array(z.string()).default(["accept_terms", "accept_offer"]),
  standing: z
    .looseObject({
      vct_values: z.array(z.string()),
      max_lifetime_months: z.number().int().min(1).max(3),
      max_per_employer: z.number().int().min(1).max(3),
      max_breadth: z.enum(["narrow", "broad"]),
      taxonomies: z.array(z.string()),
    })
    .optional(),
  action: z.looseObject({ max_lifetime_seconds: z.number().int().positive() }).optional(),
  policy_id: z.url().optional(),
});
export type UserMandatesPolicy = z.infer<typeof UserMandatesPolicy>;
