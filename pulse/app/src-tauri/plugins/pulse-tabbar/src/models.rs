use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// `UITabBar` shows at most five items itself; past that UIKit silently
/// collapses the tail into a system-owned "More" tab with its own navigation
/// stack. That tab is not in our list, so a tap on it would emit no selection
/// and the route sync would go quiet with no error. Reject the sixth tab
/// instead of shipping a bar that half-works.
pub const MAX_TABS: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabItem {
    /// Stable identifier. Echoed back verbatim on selection, so the webview
    /// can map it to a route without knowing the bar's ordering.
    pub id: String,
    pub title: String,
    /// SF Symbol name, e.g. `house`. A tab without one renders title-only.
    #[serde(default)]
    pub system_image: Option<String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTabsOptions {
    /// An empty list tears the bar down and restores the webview's inset.
    pub tabs: Vec<TabItem>,
    #[serde(default)]
    pub selected_id: Option<String>,
}

// Serialized as well as deserialized: this one crosses the FFI to Swift as-is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSelectedTabOptions {
    pub id: String,
}

/// Payload pushed up the channel when the user taps a tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSelected {
    pub id: String,
}

impl SetTabsOptions {
    /// Rejects tab sets UIKit would render in a way the route sync cannot
    /// follow. Everything here is a mistake in our own webview code rather
    /// than hostile input, so the errors name the problem.
    pub fn validate(&self) -> Result<()> {
        if self.tabs.len() > MAX_TABS {
            return Err(Error::InvalidTabs(format!(
                "at most {MAX_TABS} tabs, got {}",
                self.tabs.len()
            )));
        }

        for tab in &self.tabs {
            if tab.id.is_empty() {
                return Err(Error::InvalidTabs("a tab has an empty id".into()));
            }
            if tab.title.is_empty() {
                return Err(Error::InvalidTabs(format!(
                    "tab `{}` has an empty title",
                    tab.id
                )));
            }
        }

        for (i, tab) in self.tabs.iter().enumerate() {
            if self.tabs[..i].iter().any(|earlier| earlier.id == tab.id) {
                return Err(Error::InvalidTabs(format!("duplicate tab id `{}`", tab.id)));
            }
        }

        if let Some(selected) = &self.selected_id {
            if !self.tabs.iter().any(|tab| &tab.id == selected) {
                return Err(Error::InvalidTabs(format!(
                    "selected id `{selected}` is not one of the tabs"
                )));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str) -> TabItem {
        TabItem {
            id: id.into(),
            title: id.into(),
            system_image: None,
            enabled: true,
        }
    }

    fn options(tabs: Vec<TabItem>, selected: Option<&str>) -> SetTabsOptions {
        SetTabsOptions {
            tabs,
            selected_id: selected.map(Into::into),
        }
    }

    #[test]
    fn a_normal_tab_set_validates() {
        assert!(options(vec![tab("home"), tab("calendar")], Some("home"))
            .validate()
            .is_ok());
    }

    #[test]
    fn an_empty_tab_set_validates_because_it_means_teardown() {
        assert!(options(vec![], None).validate().is_ok());
    }

    #[test]
    fn a_sixth_tab_is_rejected_before_uikit_hides_it_behind_more() {
        let tabs = (0..=MAX_TABS).map(|i| tab(&i.to_string())).collect();
        let err = options(tabs, None).validate().unwrap_err().to_string();
        assert!(err.contains("at most 5 tabs"), "{err}");
    }

    #[test]
    fn duplicate_ids_are_rejected_because_selection_would_be_ambiguous() {
        let err = options(vec![tab("home"), tab("home")], None)
            .validate()
            .unwrap_err()
            .to_string();
        assert!(err.contains("duplicate tab id `home`"), "{err}");
    }

    #[test]
    fn an_empty_id_is_rejected() {
        let err = options(vec![tab("")], None).validate().unwrap_err();
        assert!(err.to_string().contains("empty id"));
    }

    #[test]
    fn an_empty_title_is_rejected() {
        let mut only = tab("home");
        only.title = String::new();
        let err = options(vec![only], None).validate().unwrap_err();
        assert!(err.to_string().contains("empty title"));
    }

    #[test]
    fn selecting_a_tab_that_is_not_in_the_list_is_rejected() {
        let err = options(vec![tab("home")], Some("calendar"))
            .validate()
            .unwrap_err()
            .to_string();
        assert!(err.contains("`calendar` is not one of the tabs"), "{err}");
    }

    #[test]
    fn enabled_defaults_to_true_so_a_tab_is_never_silently_dead() {
        let parsed: TabItem =
            serde_json::from_str(r#"{"id":"home","title":"Home"}"#).expect("parses");
        assert!(parsed.enabled);
        assert_eq!(parsed.system_image, None);
    }
}
