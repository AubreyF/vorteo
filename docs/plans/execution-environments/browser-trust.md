# Browser trust separation

Status: future project. The first release blocks guest automation into a client holding host authority.

Restore useful browser automation with separate profiles and explicit authority per daemon/environment. The reviewed desktop source uses a shared persistent browser partition. Separate origins alone do not prevent an automation controller from manipulating another privileged session.

Audit browser command routing, navigation, popups, downloads, clipboard bridges, saved sessions, profile persistence, and access to application control surfaces. Deny navigation or automation into privileged owner origins from lower-trust sessions. Keep approval UI outside the automatable guest profile.

Acceptance: a malicious guest cannot navigate to, inspect, click, or extract credentials from the host control interface, including after reconnect and through alternate windows. Confirm normal guest browsing still works in its own profile.

Interim: Host agents use the headless browser host described in [host and container execution](../../execution-installation.md#browser-tools-for-host-agents). It keeps automation out of the installation interface by using a separate, empty browser. It is not this project's per-daemon profile separation and does not serve container agents.

Can ship independently of runtime adapters using two test daemons. Do not combine it with browser credential delegation, which has a separate authority model and project.
