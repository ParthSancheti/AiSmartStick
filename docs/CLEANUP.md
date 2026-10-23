# Repository maintenance

The source tree keeps the app, firmware, native Android code, tests, reusable build/replay tools, configuration examples and rebuilding documentation. Hardware CAD and assembly images live with the hardware documentation. Active branding and the local detector model remain required app assets.

The 18 October 2026 cleanup removed obsolete duplicate APKs and source ZIPs, old generated replay copies, raw device/cloud logs, screenshots, an unrelated iOS note, a machine-specific image inventory and one-off migration/demo helpers from the working tree. Duplicate root logos were removed; the canonical editable logo is `src/core/brand/logo.png`. An unneeded third-party diagnostic photograph was archived; scene diagnostic helpers now require an explicit `--image <local-public-test.jpg>` fixture and explain that it is uploaded. Earlier system/walking/provenance reports are grouped in [history](history/README.md).

## Recovering local material

Removed files were moved to a sibling backup directory named `AiSmartStick-cleanup-backup-2026-10-18`; they were not permanently deleted. Its `manifest.json` records every original relative path, byte count and SHA-256. This local backup contains private diagnostics and is deliberately excluded from publication.

To restore one file, find its relative path in that manifest, verify the backup file's SHA-256, and copy that file back to the matching project-relative location. Check for an existing destination before copying. Restore only files needed for a specific investigation; do not publish the whole backup.

## Keeping the repository clean

- Keep credentials in the ignored local configuration described by the setup guides. Commit examples only.
- Write local phone/cloud evidence under ignored `validation/` and generated APKs, bundles and videos under ignored `deliverables/`.
- Publish intentional distributable APKs using GitHub Releases and document their checksums. Raw diagnostic screenshots and account/device exports do not belong in release assets.
- Regenerate the portable algorithm with `npm run algorithm:build`, then check it with `npm run algorithm:smoke`. Source and replay tools are authoritative; generated copies are disposable.
- Prefer updating a durable guide over adding another dated report to the project root.

Ignoring a path does not remove files already tracked in Git or erase historical commits. Review the staged changes and existing history before publishing.
