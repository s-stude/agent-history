#!/usr/bin/env bash
# Links every skill folder in this directory into this project's Codex skills folder:
#   <project>/.agents/skills/<dir> -> ../../skills/<dir>   (relative, so the links survive moving or cloning the repo)
# <project> is the folder that contains this skills/ directory.
# Safe to rerun: correct links are left alone; anything else with the same name is reported and never replaced.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(dirname "$SRC")"
DEST="$PROJECT/.agents/skills"

mkdir -p "$DEST"
echo "Linking skills for Codex: $SRC/* -> $DEST/"
linked=0; kept=0; skipped=0
for dir in "$SRC"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  target="../../$(basename "$SRC")/$name"
  link="$DEST/$name"
  if [ -L "$link" ]; then
    current="$(readlink "$link")"
    if [ "$current" = "$target" ]; then
      echo "  ok       $name (already linked)"
      kept=$((kept + 1))
    else
      echo "  skipped  $name: $link already links to $current"
      skipped=$((skipped + 1))
    fi
  elif [ -e "$link" ]; then
    echo "  skipped  $name: $link exists and is not a symlink"
    skipped=$((skipped + 1))
  else
    ln -s "$target" "$link"
    echo "  linked   $name: $link -> $target"
    linked=$((linked + 1))
  fi
done
echo "Done: $linked linked, $kept already linked, $skipped skipped (in $DEST)"
