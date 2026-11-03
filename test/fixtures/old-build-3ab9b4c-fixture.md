# Pinned old-build rollback fixture

`old-build-3ab9b4c-fixture.tar` is a test-only snapshot of `src/`, `scripts/`, `templates/`, `skills/`, `gallery/`, and `package.json` from Summon commit `3ab9b4c74e9d0333b9eb333afbe9713732112301`. These are the files the old CLI needs for the rollback exercise. The archive contains no Git history, dependencies, runtime store, reports, or installer. The test extracts it into a disposable directory and links the current locked dependencies so it executes the original old reader and delivery code.

The archive is exactly 1,812,480 bytes with SHA-256 `e6364c067e6df3836ee66168ce14943ff92b11eda9cb4d9dd0a1890a5a416707`. The fixture checks that hash before extraction. It was generated from the preserved local historical checkout with:

```text
git archive --format=tar --output=old-build-3ab9b4c-fixture.tar 3ab9b4c74e9d0333b9eb333afbe9713732112301 src scripts templates skills gallery package.json
```

This preserves the real old-build test on a fresh public clone without restoring the pre-1.0 Git ancestry.
