// ============================================================
//  FIREBASE — KONFIGURACJA
//
//  Uzupełnij swoimi danymi z Firebase Console:
//  1. Wejdź na https://console.firebase.google.com
//  2. Wybierz (lub utwórz) projekt
//  3. Project settings → Your apps → SDK setup → Config
//  4. Skopiuj obiekt firebaseConfig i wklej poniżej
//
//  UWAGA: Ten plik trafi na GitHub Pages — NIE wpisuj
//  sekretnych kluczy backendu. Klucze frontendowe Firebase
//  są bezpieczne o ile zabezpieczysz reguły Firestore.
// ============================================================

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCgHTkg2qFFkf7byguhwhmVGCaVcAjU0LE",
  authDomain:        "kalendarz-2e225.firebaseapp.com",
  projectId:         "kalendarz-2e225",
  storageBucket:     "kalendarz-2e225.firebasestorage.app",
  messagingSenderId: "886875628607",
  appId:             "1:886875628607:web:a848d9db8c0a7c70e8448a"
};

// ============================================================
//  REGUŁY FIRESTORE (wklej w Firebase Console → Firestore → Rules)
//
//  rules_version = '2';
//  service cloud.firestore {
//    match /databases/{database}/documents {
//      // Dostęp tylko do dokumentów swojej rodziny
//      match /families/{familyId}/{document=**} {
//        allow read, write: if true; // tymczasowe — zabezpiecz po uruchomieniu
//      }
//    }
//  }
//
//  Docelowe reguły (po uruchomieniu):
//  Ponieważ autentykacja jest oparta na PIN + link, nie ma
//  Firebase Auth — zostaw reguły otwarte i chroń przez
//  obscurity (tajny link). Ewentualnie dodaj Firebase Auth Anonymous.
// ============================================================
