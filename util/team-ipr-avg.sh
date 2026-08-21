#!/bin/bash

if [[ -z "$CURRENT_SEASON" ]]; then
    echo "CURRENT_SEASON is not set, using default!"
    CURRENT_SEASON="season-23"
else
    echo "CURRENT_SEASON: $CURRENT_SEASON"
fi

MATCH_DIR="../../data/$CURRENT_SEASON/matches"
OUTPUT_FILE="$MATCH_DIR/../team_ipr.csv"

if ! command -v jq &> /dev/null || ! command -v mlr &> /dev/null; then
    echo "Error: jq and mlr (Miller) are required for this script."
    exit 1
fi

# Collect raw data with week numbers
RAW_DATA=$(
    echo "team,week,match_ipr"
    for file in "$MATCH_DIR"/*.json; do
        # Extract the week number (3rd part of filename)
        FILENAME=$(basename "$file")
        WEEK=$(echo "$FILENAME" | cut -d'-' -f3)

        # Only operate on files from weeks 1 through 10
        if [[ "$WEEK" =~ ^[0-9]+$ ]] && [ "$WEEK" -ge 1 ] && [ "$WEEK" -le 10 ]; then
            echo "Processing: $FILENAME" >&2
            
            jq -r --arg week "$WEEK" '
                def calc(obj):
                    [ (obj.lineup // [])[] | select(.num_played != null and .IPR != null) | (.num_played * .IPR) ]
                    | (add // 0) / 3 | round;
                if .away.key != null and .home.key != null then
                    "\(.away.key),\($week),\(calc(.away))",
                    "\(.home.key),\($week),\(calc(.home))"
                else
                    empty
                end
            ' "$file"
        fi
    done
)

# Reshape, calculate Avg, Sort, and Save/Display
echo "$RAW_DATA" | \
  mlr --csv reshape -s week,match_ipr | \
  awk -F, '
    BEGIN { OFS="," }
    NR == 1 {
        print "team,1,2,3,4,5,6,7,8,9,10,Avg"
        for (i=1; i<=NF; i++) col[$i] = i
        next
    }
    {
        sum = 0; count = 0;
        row_str = $col["team"]
        for (w=1; w<=10; w++) {
            val = $col[w]
            row_str = row_str "," val
            if (val != "") {
                sum += val
                count++
            }
        }
        avg = (count > 0) ? sum / count : 0;
        printf "%s,%.1f\n", row_str, avg
    }
  ' | \
  mlr --csv sort -n Avg | \
  tee "$OUTPUT_FILE"

echo -e "\nTeam IPR data for weeks 1-10 saved to: $OUTPUT_FILE" >&2
