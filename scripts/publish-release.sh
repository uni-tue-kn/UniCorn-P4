#!/usr/bin/env bash
set -euo pipefail
: "${VERSION:?VERSION must be set}"
: "${TAG:?TAG must be set}"
: "${LATEST:?LATEST must be set}"
: "${RELEASE_ARCHIVE:?RELEASE_ARCHIVE must be set}"
: "${RELEASE_NOTES:?RELEASE_NOTES must be set}"

if gh release view "$TAG" >/dev/null 2>&1; then
    if [[ -s "$RELEASE_NOTES" ]]; then
        gh release edit "$TAG" --notes-file "$RELEASE_NOTES"
    fi
    gh release upload "$TAG" "$RELEASE_ARCHIVE" --clobber
else
    notes=(--generate-notes)
    if [[ -s "$RELEASE_NOTES" ]]; then notes=(--notes-file "$RELEASE_NOTES"); fi
    gh release create "$TAG" "$RELEASE_ARCHIVE" --verify-tag --title "v$VERSION" "${notes[@]}" --latest="$LATEST"
fi
