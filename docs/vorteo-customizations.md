# Vorteo customizations beyond Paseo

Maintenance review (2026-10-29): integrate the reviewed core-services contribution with current local-access and provider-history source. Preserve cancellation-safe idle close, stale-observation refusal, verified tool-bridge bytes, conservative scratch cleanup and pinned build runtime. Source integration does not install or activate these changes; live gateway records remain separate.

Maintenance review (2026-10-29): second independent-review corrections. Idle release keeps admission closed with a cancellation-proof marker. The scratch reaper revalidates process visibility at every deletion and protects commits under any local ref. Not installed. README overview and onboarding are unchanged.

Maintenance review (2026-10-29): independent-review corrections for the core-services branch. Idle release is atomic against run admission and refuses stale samples. The session host verifies its pinned tool bridge bytes. The scratch reaper fails closed on nested repositories, unique refs, stashes and incomplete visibility. Hosted app builds verify Node. The plan status is reconciled. Not installed. README overview and onboarding are unchanged.

Maintenance review (2026-10-29): integrates the core-services branch. It adds the native custom-domain gateway, the hosted app tool and the Dev scratch reaper. It fixes idle provider processes, slow reconnection after daemon restarts, the session host tool bridge and the preview broker identity check. See the [core services plan](plans/execution-environments/host-core-services.md). The gateway, the Vorton Host release and the broker fix are already live on the owner installation; the daemon and client fixes still need installation. README overview and onboarding are unchanged.
