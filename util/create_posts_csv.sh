#!/bin/bash

INPUT_DIR="../../data/posts/"
OUTPUT_DIR="../../data"
PLAYER_FILE="$OUTPUT_DIR/season-all_players.csv"
MACHINE_FILE="$OUTPUT_DIR/machines.json"

mkdir -p "$OUTPUT_DIR"

ADMIN_HEADER="Event,when,TimeLocal,user_id,ukey,ukey_Name,Roster_Team,Venue,path,mkey,mkey_Name,key,key_Name,name,role"
SEASON_HEADER="Event,when,TimeLocal,user_id,ukey,ukey_Name,Season,Week,Away,Home,Round_Num,Game_Num,path,mkey,mkey_Name,team,key,key_Name,name,left,right,Side,state,round,machine.1,player_1.1,player_1.1_Name,player_2.1,player_2.1_Name,player_3.1,player_3.1_Name,player_4.1,player_4.1_Name,machine.2,player_1.2,player_1.2_Name,player_2.2,player_2.2_Name,player_3.2,player_3.2_Name,player_4.2,player_4.2_Name,machine.3,player_1.3,player_1.3_Name,player_2.3,player_2.3_Name,player_3.3,player_3.3_Name,player_4.3,player_4.3_Name,machine.4,player_1.4,player_1.4_Name,player_2.4,player_2.4_Name,player_3.4,player_3.4_Name,player_4.4,player_4.4_Name,machine.5,player_1.5,player_1.5_Name,player_2.5,player_2.5_Name,machine.6,player_1.6,player_1.6_Name,player_2.6,player_2.6_Name,machine.7,player_1.7,player_1.7_Name,player_2.7,player_2.7_Name,score_1,score_2,score_3,score_4,photo_data,photo_rotation,photo_scale,photo_dx,photo_dy"

find "$INPUT_DIR" -maxdepth 1 -type f -size +0c -exec grep -o '"path":"/matches/[^/]*-[0-9]*-' {} + | \
grep -o '[0-9]\+' | sort -u | xargs -I{} mkdir -p "$OUTPUT_DIR/season-{}"

TOTAL_FILES=$(find "$INPUT_DIR" -maxdepth 1 -type f -size +0c | wc -l)

find "$INPUT_DIR" -maxdepth 1 -type f -size +0c -print0 | \
  pv -0 -l -s "$TOTAL_FILES" --name "Files Processed" | \
  xargs -0 cat | \
  jq -r --slurpfile players <(
    if [ -f "$PLAYER_FILE" ]; then
      jq -R 'split(",") | map(gsub("\""; "")) | select(length >= 2)' "$PLAYER_FILE" |
      jq -cs '.[1:] | map({(.[1]): .[0]}) | add'
    else echo "{}" ; fi
  ) --slurpfile machines <(
    if [ -f "$MACHINE_FILE" ]; then cat "$MACHINE_FILE"; else echo "{}" ; fi
  ) '
  try (
    select(type == "object") |
    ($players | .[0]) as $p_map |
    ($machines | .[0]) as $m_map |

    (.path? // "") as $orig_path |
    ($orig_path | ascii_downcase) as $p_low |
    ($orig_path | split("/") | map(select(length > 0))) as $slash_parts |
    ($slash_parts | map(select(test("-.*-.*-"))) | .[0] // "") as $id_str |
    ($id_str | split("-")) as $d |
    (($d[-1] // "") | split(".")) as $dot |

    (if ($p_low | startswith("/teams")) then ($slash_parts[1] // null) else null end) as $roster_team |
    (if ($p_low | startswith("/venues")) then ($slash_parts[1] // null) else null end) as $venue_name |

    ({
      season: (($d[1]? | tonumber?) // null),
      week: (($d[2]? | tonumber?) // null),
      away: ($d[3]? // null),
      home: ($dot[0]? // null),
      playernum: (($dot[1]? | tonumber?) // null),
      gamenum: (($dot[2]? | tonumber?) // null)
    }) as $p |

    (
      if ($p_low | startswith("/machines")) and .body?.mkey and .body?.name then "MACHINE_ADD"
      elif ($p_low | startswith("/machines")) and ($p_low | endswith("/remove")) then "MACHINE_REMOVE"
      elif ($p_low | startswith("/teams")) and ($p_low | endswith("/roster/add")) then "ROSTER_ADD"
      elif ($p_low | startswith("/teams")) and ($p_low | endswith("/roster/remove")) then "ROSTER_REMOVE"
      elif ($p_low | startswith("/venues")) and ($p_low | endswith("/add")) then "VENUE_MACHINE_ADD"
      elif ($p_low | startswith("/venues")) and ($p_low | endswith("/remove")) then "VENUE_MACHINE_REMOVE"
      elif ($p_low | startswith("/matches")) and ($p_low | endswith("/venue/add")) then "MATCH_MACHINE_ADD"
      elif ($p_low | startswith("/matches")) and ($p_low | endswith("/venue/remove")) then "MATCH_MACHINE_REMOVE"
      elif ($p_low | startswith("/matches")) and ($p_low | endswith("/players/add")) then "MATCH_PLAYER_ADD"
      elif ($p_low | startswith("/matches")) and ($p_low | endswith("/players/remove")) then "MATCH_PLAYER_REMOVE"
      elif ($p_low | startswith("/matches")) and ($p_low | endswith("/ready")) then "MATCH_READY"
      elif ($p_low | startswith("/matches")) and ($p_low | endswith("/picks")) and .body?.state == "picking" then "MATCH_PICK"
      elif ($p_low | startswith("/matches")) and ($p_low | endswith("/picks")) and .body?.state == "responding" then "MATCH_RESPOND"
      elif ($p_low | startswith("/games")) and ($p_low | endswith("/report")) then "MATCH_REPORT"
      elif ($p_low | startswith("/matches")) and ($p_low | endswith("/confirm")) then "MATCH_CONFIRM"
      else "UNKNOWN"
      end
    ) as $event |

    select($event != "UNKNOWN") |

    # Check for Admin vs Season category
    (["MACHINE_ADD", "MACHINE_REMOVE", "ROSTER_ADD", "ROSTER_REMOVE", "VENUE_MACHINE_ADD", "VENUE_MACHINE_REMOVE"] | contains([$event])) as $isAdmin |

    # Filter out null seasons for match events
    select($isAdmin or ($p.season != null and $p.season != "null")) |

    # Construct Row: [TargetFile, Event, ...Data]
    (if $isAdmin then "posts_admin.csv" 
     else "season-" + ($p.season|tostring) + "/posts_season_" + ($p.season|tostring) + ".csv" 
     end) as $target |

    # Build the array - ensuring $target is the first element
    ([$target, $event, .when?, (if .when? then (.when? / 1000 | strflocaltime("%Y-%m-%d %H:%M:%S %Z")) else "" end), .user_id?, .ukey?, ($p_map[.ukey // ""] // null)]) as $common |

    (if $isAdmin then
      $common + [$roster_team, $venue_name, .path?, .body?.mkey, ($m_map[.body?.mkey // ""].name // null), .body?.key, ($p_map[.body?.key // ""] // null), .body?.name, .body?.role]
    else
      $common + [$p.season, $p.week, $p.away, $p.home, $p.playernum, $p.gamenum, .path?, .body?.mkey, ($m_map[.body?.mkey // ""].name // null), .body?.team, .body?.key, ($p_map[.body?.key // ""] // null), .body?.name, .body?.left, .body?.right, (if .body?.left != null then "LEFT" elif .body?.right != null then "RIGHT" else null end), .body?.state, .body?.round, .body?["machine.1"], .body?["player_1.1"], ($p_map[.body?["player_1.1"] // ""] // null), .body?["player_2.1"], ($p_map[.body?["player_2.1"] // ""] // null), .body?["player_3.1"], ($p_map[.body?["player_3.1"] // ""] // null), .body?["player_4.1"], ($p_map[.body?["player_4.1"] // ""] // null), .body?["machine.2"], .body?["player_1.2"], ($p_map[.body?["player_1.2"] // ""] // null), .body?["player_2.2"], ($p_map[.body?["player_2.2"] // ""] // null), .body?["player_3.2"], ($p_map[.body?["player_3.2"] // ""] // null), .body?["player_4.2"], ($p_map[.body?["player_4.2"] // ""] // null), .body?["machine.3"], .body?["player_1.3"], ($p_map[.body?["player_1.3"] // ""] // null), .body?["player_2.3"], ($p_map[.body?["player_2.3"] // ""] // null), .body?["player_3.3"], ($p_map[.body?["player_3.3"] // ""] // null), .body?["player_4.3"], ($p_map[.body?["player_4.3"] // ""] // null), .body?["machine.4"], .body?["player_1.4"], ($p_map[.body?["player_1.4"] // ""] // null), .body?["player_2.4"], ($p_map[.body?["player_2.4"] // ""] // null), .body?["player_3.4"], ($p_map[.body?["player_3.4"] // ""] // null), .body?["player_4.4"], ($p_map[.body?["player_4.4"] // ""] // null), .body?["machine.5"], .body?["player_1.5"], ($p_map[.body?["player_1.5"] // ""] // null), .body?["player_2.5"], ($p_map[.body?["player_2.5"] // ""] // null), .body?["machine.6"], .body?["player_1.6"], ($p_map[.body?["player_1.6"] // ""] // null), .body?["player_2.6"], ($p_map[.body?["player_2.6"] // ""] // null), .body?["machine.7"], .body?["player_1.7"], ($p_map[.body?["player_1.7"] // ""] // null), .body?["player_2.7"], ($p_map[.body?["player_2.7"] // ""] // null), .body?.score_1, .body?.score_2, .body?.score_3, .body?.score_4, .body?.photo_data, .body?.photo_rotation, .body?.photo_scale, .body?.photo_dx, .body?.photo_dy]
    end)

    | map(if type == "object" or type == "array" then tostring else . end)
    | @csv

) catch empty' | awk -v out_dir="${OUTPUT_DIR%/}" -v admin_h="$ADMIN_HEADER" -v season_h="$SEASON_HEADER" -F',' '{
    # Correctly parse the target filename (Column 1)
    target = $1; gsub(/^"|"$/, "", target);
    
    # Build the real path
    full_path = out_dir "/" target;

    # Strip ONLY the first column correctly
    match($0, /,[^,]*/);
    data_row = substr($0, RSTART + 1);

    if (!(full_path in created)) {
        # Check for admin header vs season header using the filename
        if (index(target, "admin") > 0) { print admin_h > full_path }
        else { print season_h > full_path }
        created[full_path] = 1;
    }
    print data_row >> full_path;
}'

# Final Individual Sorting
for f in "${OUTPUT_DIR%/}/posts_admin.csv" "${OUTPUT_DIR%/}"/season-*/posts_season_*.csv; do
    [ -e "$f" ] || continue
    (head -n 1 "$f" && tail -n +2 "$f" | sort -t',' -k2,2n) > "${f}.tmp" && mv "${f}.tmp" "$f"
done
