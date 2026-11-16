#!/usr/bin/env bash
# Renders the screenshot fixtures. face.jpeg is a StyleGAN portrait of nobody from
# thispersondoesnotexist.com, stripped and resized with: magick in.jpeg -strip -resize 256x256 -quality 80 face.jpeg
set -euo pipefail
cd "$(dirname "$0")"

screen() {
	local out=$1 title=$2
	shift 2
	local draw=(-fill '#1f3a5f' -draw 'rectangle 0,0 640,44' -fill white -font Liberation-Sans-Bold -pointsize 18 -draw "text 16,29 '$title'")
	local y=84
	for row in "$@"; do
		local label=${row%%|*} value=${row#*|}
		draw+=(-fill '#5b6b7b' -font Liberation-Sans -pointsize 15 -draw "text 24,$y '$label'")
		draw+=(-fill '#111111' -font Liberation-Sans-Bold -pointsize 15 -draw "text 210,$y '$value'")
		draw+=(-fill '#e3e8ee' -draw "line 16,$((y + 12)) 624,$((y + 12))")
		y=$((y + 34))
	done
	magick -size 640x300 xc:'#f7f9fb' "${draw[@]}" -strip -quality 80 "$out"
}

screen claim-screenshot.jpeg 'Northfield Claims - Denial review' \
	'Patient|Coriel Pellstone' \
	'Date of birth|03/14/1987' \
	'Claim|CLM-20481' \
	'Status|DENIED  CO-16 missing information' \
	'Payer|Cascade Mutual Health Plan' \
	'Assigned to|Billing queue B'

screen clean-screenshot.jpeg 'Northfield Claims - Denials overview' \
	'Open denials|18' \
	'CO-16 missing information|7' \
	'CO-97 bundled service|4' \
	'Oldest open claim|CLM-20311  (12 days)' \
	'Last sync|2025-03-04 02:15 UTC  ok' \
	'Build|claims-ui 4.12.0'
