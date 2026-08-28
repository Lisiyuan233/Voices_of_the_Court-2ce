//! family predicate 构造（实施计划 Task 4 步骤 3/5/6，registry 见 5.5 节）。
//!
//! - `character.spouse`：对称关系按 ID 排序只输出一次 canonical pair；
//! - `character.parent`：只接受普通 mother/father 字段（real/secret father
//!   在 character.rs 白名单解析层就从不读取）；
//! - `character.child`：由已接受 parent 事实反向派生，与 parent 共享
//!   source evidence（同一 sourcePath）与 provenance，confidence 为
//!   `mapped`（派生）。
//!
//! 一跳邻域：只保留 subject 或 object 至少一侧是 participant 的关系；
//! related character 的亲属不继续展开（realm.rs 同理只收 participant 的
//! liege/primary_title）。

use super::character::CharacterRecord;
use super::normalize::FactSink;
use crate::protocol::{
    Category, Confidence, EntityType, FactSensitivity, FactVisibility, Predicate,
};

/// canonical source path（协议 5.4 枚举值，raw save 路径永不过线；
/// 与 App `saveFactTypes.ts` 的 `SAVE_FACT_SOURCE_PATHS` 一一对应）。
const SRC_MOTHER: &str = "character_mother";
const SRC_FATHER: &str = "character_father";
const SRC_CHILD: &str = "character_child";
const SRC_SPOUSE: &str = "character_spouse";

/// 把一个角色记录中的家庭关系写进 sink。
/// `is_participant`：该角色本身是 participant（参与者侧关系全收）；
/// 非 participant 只保留指向 participant 的反向关系。
pub(crate) fn record_character_family(
    sink: &mut FactSink,
    char_id: &str,
    rec: &CharacterRecord,
    is_participant: bool,
) {
    let involves = |sink: &FactSink, other: &str| is_participant || sink.is_participant(other);

    if let Some(mother) = &rec.mother {
        if involves(sink, mother) {
            push_parent(sink, char_id, mother, SRC_MOTHER);
        }
    }
    if let Some(father) = &rec.father {
        if involves(sink, father) {
            push_parent(sink, char_id, father, SRC_FATHER);
        }
    }
    for child in &rec.children {
        if involves(sink, child) {
            push_child(sink, char_id, child);
        }
    }
    for spouse in &rec.spouses {
        if !involves(sink, spouse) {
            continue;
        }
        // canonical pair：按 ID 排序，较小者为 subject，只输出一次。
        if let Some((first, second)) = sink.admit_spouse_pair(char_id, spouse) {
            sink.push_fact(
                Category::Family,
                (EntityType::Character, &first),
                Predicate::CharacterSpouse,
                Some((EntityType::Character, &second)),
                SRC_SPOUSE,
                Confidence::Exact,
                FactVisibility::Public,
                FactSensitivity::Personal,
            );
        }
    }
}

/// CK3 1.19 stores the public relation in the parent's `family_data.child`
/// list.  Emit that direct fact as exact and derive the inverse parent fact.
fn push_child(sink: &mut FactSink, parent: &str, child: &str) {
    sink.push_fact(
        Category::Family,
        (EntityType::Character, parent),
        Predicate::CharacterChild,
        Some((EntityType::Character, child)),
        SRC_CHILD,
        Confidence::Exact,
        FactVisibility::Public,
        FactSensitivity::Personal,
    );
    sink.push_fact(
        Category::Family,
        (EntityType::Character, child),
        Predicate::CharacterParent,
        Some((EntityType::Character, parent)),
        SRC_CHILD,
        Confidence::Mapped,
        FactVisibility::Public,
        FactSensitivity::Personal,
    );
}

/// parent 事实 + 反向派生 child 事实（共享 source evidence/provenance）。
fn push_parent(sink: &mut FactSink, child: &str, parent: &str, source_path: &'static str) {
    sink.push_fact(
        Category::Family,
        (EntityType::Character, child),
        Predicate::CharacterParent,
        Some((EntityType::Character, parent)),
        source_path,
        Confidence::Exact,
        FactVisibility::Public,
        FactSensitivity::Personal,
    );
    sink.push_fact(
        Category::Family,
        (EntityType::Character, parent),
        Predicate::CharacterChild,
        Some((EntityType::Character, child)),
        source_path,        // 与 parent 共享 source evidence
        Confidence::Mapped, // 反向派生
        FactVisibility::Public,
        FactSensitivity::Personal,
    );
}
