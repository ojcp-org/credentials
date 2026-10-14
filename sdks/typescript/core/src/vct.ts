/**
 * SD-JWT VC Type Metadata for the OJCP types (SD-JWT VC draft-13 §6), and their
 * `vct#integrity` values. Each document is served as its JCS serialization, so
 * every SDK computes the same integrity from the same object.
 */
import { jcs, sri } from "./digest.ts";
import { HIRING_VCT, type HiringType } from "./hiring/types.ts";
import { STANDING_MANDATE_VCT } from "./mandate/model.ts";

interface ClaimMetadata {
  path: Array<string | null>;
  display: Array<{ locale: string; label: string }>;
  sd: "always" | "allowed" | "never";
}

export interface TypeMetadata {
  vct: string;
  name: string;
  description: string;
  display: Array<{ locale: string; name: string; description: string }>;
  claims: ClaimMetadata[];
}

const claim = (
  path: Array<string | null>,
  label: string,
  sdMode: ClaimMetadata["sd"] = "always",
): ClaimMetadata => ({
  path,
  display: [{ locale: "en-US", label }],
  sd: sdMode,
});

const common = (): ClaimMetadata[] => [
  claim(["basis"], "What the issuer's statement rests on", "never"),
  claim(["given_name"], "Given name"),
  claim(["family_name"], "Family name"),
];

function doc(
  vct: string,
  name: string,
  description: string,
  claims: ClaimMetadata[],
): TypeMetadata {
  return { vct, name, description, display: [{ locale: "en-US", name, description }], claims };
}

export const TYPE_METADATA: Record<HiringType | "standing_mandate", TypeMetadata> = {
  employment: doc(
    HIRING_VCT.employment,
    "Employment record",
    "A job held at an organization (RFC 0014).",
    [
      claim(["organization"], "Organization"),
      claim(["current"], "Currently employed"),
      claim(["start"], "Start date"),
      claim(["end"], "End date"),
      claim(["positionHistories"], "Positions held"),
      claim(["start_year"], "Start year"),
      claim(["end_year"], "End year"),
      claim(["tenure_years"], "Years employed"),
      ...common(),
    ],
  ),
  education: doc(
    HIRING_VCT.education,
    "Education record",
    "A degree or program at an institution (RFC 0014).",
    [
      claim(["institution"], "Institution"),
      claim(["educationDegrees"], "Degrees"),
      claim(["programs"], "Programs"),
      claim(["degree_level"], "Degree level (ISCED 2011)"),
      claim(["degree_year"], "Degree year"),
      ...common(),
    ],
  ),
  professional_license: doc(
    HIRING_VCT.professional_license,
    "Professional license",
    "A license issued by an authority (RFC 0014).",
    [claim(["license"], "License"), ...common()],
  ),
  certification: doc(
    HIRING_VCT.certification,
    "Certification",
    "A certification issued by an authority (RFC 0014).",
    [claim(["certification"], "Certification"), ...common()],
  ),
  standing_mandate: doc(
    STANDING_MANDATE_VCT,
    "Standing mandate",
    "Permission for one agent to apply for jobs on a candidate's behalf within limits, until a date (RFC 0008).",
    [
      claim(["candidate", null], "Candidate contact"),
      claim(["scope", "job_families", null], "Job families"),
      claim(["scope", "locations", null], "Places"),
      claim(["scope", "remote_policy", null], "Work arrangements"),
      claim(["scope", "employment_type", null], "Employment types"),
      claim(["scope", "experience_level", null], "Experience levels"),
      claim(["scope", "salary", null], "Pay"),
      claim(["actions", null], "Permitted actions"),
      claim(["limits"], "Limits", "never"),
      claim(["prohibited"], "Never permitted", "never"),
      claim(["consent_scope"], "Candidate data the agent may share", "never"),
      claim(["provider_trust_floor"], "Minimum employer trust", "never"),
    ],
  ),
};

/** The exact bytes served for a type's metadata. */
export function typeMetadataBytes(metadata: TypeMetadata): string {
  return jcs(metadata);
}

/** `vct#integrity` for a type: SRI sha256 of the served bytes. */
export function vctIntegrity(metadata: TypeMetadata): Promise<string> {
  return sri(typeMetadataBytes(metadata));
}
