//! Fixed-section character profile projection (Plan B Task 4).
//!
//! Sections are deduplicated and emitted in canonical order; missing optional
//! fields are omitted rather than faked as empty/false. Only requested
//! sections appear in the response.

use serde::Serialize;

use crate::session::index::{SessionCharacterRecord, SessionIndex};
use crate::session::protocol::{ProfileSection, ALL_PROFILE_SECTIONS};

/// Maximum sections per profile request (frozen cap table).
pub(crate) const MAX_PROFILE_SECTIONS: usize = 5;

/// Canonicalize requested sections: dedupe + fixed order.
pub(crate) fn canonical_sections(requested: &[ProfileSection]) -> Vec<ProfileSection> {
    ALL_PROFILE_SECTIONS
        .iter()
        .copied()
        .filter(|section| requested.contains(section))
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileSectionOut {
    pub kind: ProfileSection,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileData {
    pub character_id: String,
    pub identity: IdentityBlock,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_family: Option<FamilyBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realm: Option<RealmBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub court: Option<CourtBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<LocationBlock>,
    /// Only requested sections appear here; serialization order is stable
    /// (sorted) because the map is ordered and keys are canonical.
    pub section_status: std::collections::BTreeMap<&'static str, &'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityBlock {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_title_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FamilyBlock {
    pub spouse_ids: Vec<String>,
    pub parent_ids: Vec<String>,
    pub child_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RealmBlock {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub liege_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_vassal_of_id: Option<String>,
    pub domain_title_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realm_capital_title_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CourtBlock {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocationBlock {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_id: Option<String>,
}

pub(crate) struct ProfileOutput {
    pub status: &'static str,
    pub data: Option<ProfileData>,
}

fn status_for(truncated: bool) -> &'static str {
    if truncated { "partial" } else { "available" }
}

pub(crate) fn build_profile(
    index: &SessionIndex,
    character_id: &str,
    requested: &[ProfileSection],
) -> Option<ProfileOutput> {
    let record: &SessionCharacterRecord = index.characters.get(character_id)?;
    let sections = canonical_sections(requested);

    let mut out_sections: Vec<ProfileSectionOut> = Vec::new();
    let mut any_partial = false;
    let mut identity_block: Option<IdentityBlock> = None;
    let mut family_block: Option<FamilyBlock> = None;
    let mut realm_block: Option<RealmBlock> = None;
    let mut court_block: Option<CourtBlock> = None;
    let mut location_block: Option<LocationBlock> = None;
    let mut section_status: Vec<(&'static str, &'static str)> = Vec::new();

    for section in &sections {
        let (kind_key, status): (&'static str, &'static str) = match section {
            ProfileSection::Identity => {
                identity_block = Some(IdentityBlock {
                    literal_name: record.literal_name.clone(),
                    primary_title_id: record.primary_title.clone(),
                });
                let status = "available";
                out_sections.push(ProfileSectionOut {
                    kind: *section,
                    status,
                    lines: Vec::new(),
                });
                ("identity", status)
            }
            ProfileSection::PublicFamily => {
                let partial = record.sections_partial.public_family;
                if partial {
                    any_partial = true;
                }
                family_block = Some(FamilyBlock {
                    spouse_ids: record.spouses.ids.clone(),
                    parent_ids: record.parents.ids.clone(),
                    child_ids: record.children.ids.clone(),
                });
                let status = status_for(partial);
                out_sections.push(ProfileSectionOut {
                    kind: *section,
                    status,
                    lines: Vec::new(),
                });
                ("public_family", status)
            }
            ProfileSection::Realm => {
                let partial = record.sections_partial.realm;
                if partial {
                    any_partial = true;
                }
                realm_block = Some(RealmBlock {
                    liege_id: record.liege.clone(),
                    direct_vassal_of_id: record.direct_vassal_of.clone(),
                    domain_title_ids: record.domains.ids.clone(),
                    realm_capital_title_id: record.realm_capital.clone(),
                });
                let status = status_for(partial);
                out_sections.push(ProfileSectionOut {
                    kind: *section,
                    status,
                    lines: Vec::new(),
                });
                ("realm", status)
            }
            ProfileSection::Court => {
                court_block = Some(CourtBlock {
                    owner_id: record.court_owner.clone(),
                });
                let status = "available";
                out_sections.push(ProfileSectionOut {
                    kind: *section,
                    status,
                    lines: Vec::new(),
                });
                ("court", status)
            }
            ProfileSection::Location => {
                location_block = Some(LocationBlock {
                    location_id: record.public_location.clone(),
                });
                let status = "available";
                out_sections.push(ProfileSectionOut {
                    kind: *section,
                    status,
                    lines: Vec::new(),
                });
                ("location", status)
            }
        };
        section_status.push((kind_key, status));
    }

    let status_map: std::collections::BTreeMap<&'static str, &'static str> =
        section_status.into_iter().collect();

    Some(ProfileOutput {
        status: if any_partial { "partial" } else { "ok" },
        data: Some(ProfileData {
            character_id: character_id.to_string(),
            identity: identity_block.unwrap_or(IdentityBlock {
                literal_name: None,
                primary_title_id: None,
            }),
            public_family: family_block,
            realm: realm_block,
            court: court_block,
            location: location_block,
            section_status: status_map,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_are_deduped_into_canonical_order() {
        let requested = vec![
            ProfileSection::Location,
            ProfileSection::Identity,
            ProfileSection::Realm,
            ProfileSection::Identity,
        ];
        let ordered = canonical_sections(&requested);
        assert_eq!(
            ordered,
            vec![
                ProfileSection::Identity,
                ProfileSection::Realm,
                ProfileSection::Location
            ]
        );
    }

    #[test]
    fn partial_flags_only_come_from_truncated_family_or_realm() {
        assert_eq!(status_for(false), "available");
        assert_eq!(status_for(true), "partial");
    }
}
