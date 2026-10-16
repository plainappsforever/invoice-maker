# Invoice Maker

Invoices, quotes and receipts with VAT, PDF and GiroCode. Offline, no ads.

Write an invoice on your phone, add the details German VAT law lists, and share it as a PDF. Everything stays on your phone. No account, no subscription, no ads and no limit on the number of documents.

**Get it:** [App Store](https://plainapps.dfdsfdsfsdf.workers.dev/apps/invoice-maker/) · [Google Play](https://plainapps.dfdsfdsfsdf.workers.dev/apps/invoice-maker/) · [GitHub Releases](https://github.com/plainappsforever/invoice-maker/releases) ·
[Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/plainappsforever/invoice-maker)

**Status:** first store release pending.

## Our promise

**Free, no ads, no tracking, no accounts.** This app keeps your data on your phone. It has no analytics, no crash
reporter, no advertising SDK and no sign-in. The Android release build has no INTERNET permission at all. We will not sell this app or this project to a company
that changes any of this.

Why we write it down: in 2023 a popular open-source Android suite was sold to an ad-funded app company and its store
listings started saying "Contains ads"; its community had to fork it to keep a clean version. The source code of
Invoice Maker is published under GPL-3.0, so if this promise were ever broken, anyone could continue the last
version that kept it.

## What it does

Documents
Invoices, quotes, receipts and cancellation invoices (Storno). Turn an accepted quote into an invoice, duplicate any document, and correct a mistake with a cancellation invoice and a corrected copy. An issued invoice is locked, gets the next number and is never renumbered; a number is never used twice. The invoice editor saves your changes as you type.

Quick repeat invoices
Save clients and items once. A repeat invoice for a saved client with two saved items takes nine taps, from the Invoices list to the share sheet.

Numbers
VAT per line (19 %, 7 %, 0 % or your own rates), prices with or without VAT, discounts per line and on the whole document (percent or a fixed amount), deposits and part payments. Totals are calculated to the cent, and VAT is worked out per tax rate.

Germany and the EU
The invoice has fields for the details that § 14 UStG lists: both addresses, tax number or VAT ID, date, consecutive number, quantity and description, date of supply, amounts by tax rate, and the tax amount or an exemption note. Before you issue, a check lists details that are still missing. Notes for small businesses (§ 19 UStG), reverse charge, intra-EU supply, export and exempt supplies come pre-filled in German and English with their source shown, and you can edit every note. Receipts, including small amounts up to 250 EUR, and the German window-envelope layout (DIN 5008) in the Classic template. The check and the notes are information, not tax or legal advice.

PDF and sending
Three layouts (Classic, Modern, Compact), A4 or Letter, your logo and accent colour. Long invoices run over several pages with page numbers. Euro invoices with a SEPA IBAN carry a GiroCode (EPC QR code) with your IBAN, the amount and the invoice number. The PDF has no ad, watermark or app link. Share it with any app, send it from your mail app, or print it.

Payments and reminders
Record part and full payments, create payment receipts, and see what is outstanding and overdue. If you like, the phone shows a reminder notification the day before an invoice is due and the day after, at most one a day. Reminders are set by the phone itself: no server.

Your data
Back up everything to one file and restore it on another phone, export CSV files for your tax adviser, or delete all data. Backup and CSV files are plain, not encrypted, and contain client data: keep them somewhere safe. The app has no internet permission; data leaves your phone only when you share a file, a PDF or an e-mail yourself. If you use Google's phone backup, it may include the app's data.

Languages
The app is in English and German and follows your phone. Each document can be in German or English, set per client.

Not included in this version
- E-invoices. This version creates PDF invoices, not XRechnung or ZUGFeRD files. In Germany, businesses have had to be able to receive e-invoices since 1 January 2025, and issuing them to other domestic businesses becomes the rule from 2027 or 2028, depending on turnover, with exceptions (Federal Ministry of Finance FAQ, March 2026). Ask your tax adviser what applies to you.
- Reminder letters (Mahnung), card payments or payment links, sync between phones, several businesses in one app.

## Privacy

- All data is stored locally (SQLite in the app's private storage). Nothing is uploaded.
- Files leave the phone only when you share or export them yourself.
- Privacy policy: https://plainapps.dfdsfdsfsdf.workers.dev/apps/invoice-maker/privacy

## Build from source

The app identifier `com.tim.invoicemaker` is a placeholder: the identifier changes before the first store release.

You need: **Node.js 22 LTS** (the React Native version used here accepts `^20.19.4 || ^22.13.0 || ^24.3.0`), npm,
and git. The app is an [Expo](https://expo.dev) (SDK 57) / React Native app; the native `android/` and `ios/` folders
are generated from `app.config.ts` and are not in the repository.

```sh
git clone https://github.com/plainappsforever/invoice-maker.git
cd invoice-maker
npm ci
npm run verify          # typecheck + lint + all unit tests
```

### Android (Linux, macOS or Windows)

Needs JDK 17 and the Android SDK (Android Studio installs both; set `ANDROID_HOME`).

```sh
export APP_VARIANT=production
npx expo prebuild --platform android
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
# APK: android/app/build/outputs/apk/release/ (signed with the debug key unless you configure your own key)
```

`APP_VARIANT` selects the app id and name (`development`, `preview`, `production`; see `app.config.ts`).
Builds made this way are signed with your key, not ours, so they cannot update an installed store version.

### iOS (macOS only)

Needs Xcode (26 or newer) and CocoaPods.

```sh
export APP_VARIANT=production
npx expo prebuild --platform ios
npx expo run:ios --configuration Release        # runs on the iOS Simulator
```

For a real iPhone, open `ios/*.xcworkspace` in Xcode, choose your own team under *Signing & Capabilities*
and change the bundle identifier. There is no sideloading store for iOS; the App Store build is ours.

## Verifying a release

Every GitHub release lists SHA-256 checksums (`SHA256SUMS.txt`) and the APKs are signed with one key per app.
Certificate SHA-256 fingerprint: `not yet published on Android`

## How this app was made

Invoice Maker was written with substantial help from an AI coding assistant (Claude Code), directed, reviewed and
tested by the maintainer. We say this openly because some stores and users care about it.

## Licence

Copyright (C) 2026 Farija Retkoceri

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, version 3 (GPL-3.0-only). See [LICENSE](LICENSE).
Third-party components keep their own licences (see `LICENSES/` and the app's licences screen where present).
Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
