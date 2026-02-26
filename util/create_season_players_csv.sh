#!/bin/bash

DATA_ROOT="../data"

# default regex pattern for "all seasons"
target_pattern="${1:-season-[0-9]+}"

if [ -z "$1" ]; then
    output_file="$DATA_ROOT/season-all_players.csv"
else
    output_file="$DATA_ROOT/${1%/}/players.csv"
fi

echo "name,key,last_played" > "$output_file"

find "$DATA_ROOT/" -maxdepth 4 -regex ".*/$target_pattern/matches/.*\.json" -print0 | \
    sort -z | \
    xargs -0 jq -r '
        (.date | split("/") | "\(.[2])-\(.[0])-\(.[1])") as $iso | 
        (.away.lineup? + .home.lineup?)[]? | 
        [.name, .key, $iso] | @csv
    ' | \
    sort -t, -k2,2 -k3,3r | \
    sort -t, -k2,2 -u > temp.csv

sort -t, -k1,1f temp.csv >> "$output_file"
rm temp.csv

