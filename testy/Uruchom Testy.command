#!/bin/bash
cd "$(dirname "$0")"
# Zabij poprzedni serwer jeśli działał
lsof -ti:8080 | xargs kill -9 2>/dev/null
# Uruchom serwer w tle
python3 -m http.server 8080 &
sleep 1
# Otwórz w przeglądarce
open "http://localhost:8080/#kalendarz"
wait
