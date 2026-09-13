# PLAENS Store Admin

Stock, orders, customers, expenses, profit reports, and branded PDF and email receipts for PLAENS. It's plain HTML, CSS and JavaScript: no npm, no build step, no server. Everything it needs, including fonts and libraries, is inside this folder.

## Run it in VS Code

Open this folder in VS Code (File > Open Folder). Install the **Live Server** extension if you don't have it, then right-click `index.html` and choose **Open with Live Server**.

The first time it opens, you set your store name and currency and choose whether to start with sample data or an empty store.

## Put it on GitHub Pages

Create a repository on GitHub and upload everything in this folder, keeping `index.html` at the top level. In the repository, go to Settings > Pages, set the source to "Deploy from a branch", choose `main` and `/ (root)`, and save. A minute or two later the dashboard is live at `https://your-username.github.io/your-repo-name/`.

## Two ways to store your data

**Browser mode** is the default. Data is saved inside the browser you use, on that device. It works instantly with no account, but your phone and laptop each have a separate store, and clearing browser data can erase it. Download a backup regularly from Settings.

**Firebase mode** saves your data in your own Firebase database. You sign in with an email and password, and the store is the same on every device, updating live when something changes. Firebase's free Spark plan comfortably covers a small brand.

## Connecting Firebase

This takes about 15 minutes, once.

1. Go to console.firebase.google.com, click **Create a project**, and give it a name like `plaens-admin`. You can turn Google Analytics off.
2. In the project, click the **</>** (Web) icon to add a web app. Give it a nickname and register it (you don't need Firebase Hosting). Firebase shows a `firebaseConfig` block. Keep that page open.
3. Open `js/firebase-config.js`, paste your values into `config` (apiKey, authDomain, projectId and so on), and change `enabled: false` to `enabled: true`.
4. In Firebase, open **Build > Authentication**, click **Get started**, choose **Email/Password**, turn it on and save. Then on the **Users** tab click **Add user** and create the account you'll sign in with. There's no sign-up page in the dashboard, so only people you add here can sign in.
5. Open **Build > Firestore Database**, click **Create database**, pick a location close to you, and start in **production mode**.
6. In Firestore, open the **Rules** tab, replace everything with the contents of `firestore.rules` from this folder, put your email in the list (lowercase, exactly as you created it in step 4), and press **Publish**. If you forget this step you can sign in but every screen shows a permissions error. To give a team member access, add them as a user in step 4 and add their email to this list.
7. In **Authentication > Settings > Authorized domains**, add `127.0.0.1` (for Live Server) and `your-username.github.io` (for GitHub Pages).
8. Reload the dashboard and sign in. If this browser already has store data, setup offers to copy it into Firebase.

The values in `firebase-config.js` are safe to publish on GitHub; they identify your project but don't grant access. Your data is protected by the sign-in plus the rules in step 6. Don't skip the rules.

If two people change the same thing at the same moment, the second person is told to try again rather than silently overwriting the first. In Firebase mode, saving needs an internet connection; if you're offline, the sidebar shows it and the change isn't saved.

Downloading a backup file each month is still a good habit in Firebase mode, as protection against accidental deletes.

## Receipts

Every order has a **Download PDF** button, which creates an A4 PDF of the branded receipt with your logo. On a phone, **Share receipt > Share PDF** sends the file straight to WhatsApp, Gmail or any other app. You can also print it, or send a plain text version through WhatsApp or your email app.

You can use either of two EmailJS templates. The simplest is a template whose whole content is `{{{receipt_html}}}`, which sends the same design the PDF uses. If you'd rather lay the email out yourself in EmailJS, paste `emailjs-template.html` from this folder into the template's Content tab (code view) instead; it's the same design written with EmailJS variables, so you can edit wording and colours there without touching the code.

To email the designed receipt automatically, connect EmailJS (emailjs.com, free plan available). The Settings page walks you through it; in short, the EmailJS template needs:

| Template field | Value |
|---|---|
| To Email | `{{to_email}}` |
| Subject | `{{subject}}` |
| From Name | `{{store_name}}` |
| Reply To | `{{reply_to}}` |
| Content (switch to the code/HTML editor) | `{{{receipt_html}}}` |

The logo appears in emailed receipts once the site is on GitHub Pages, because email apps need a public web address for images. PDFs always include it.

## Product photos

Open a product and use **Choose photo**, or drag an image onto the square. Photos from a phone are fine: the browser resizes and compresses each one before it's stored, turning a 4 MB photo into roughly 60 KB, plus a small square thumbnail for lists.

Photos appear in Products, Inventory, the order screens and on the PDF receipt. They are left out of emailed receipts on purpose, because Gmail and most other email apps block images that are embedded this way; the PDF is the one to send when you want the customer to see the pieces.

With Firebase connected, each photo is stored as its own record and syncs to your other devices like everything else.

## Shipping labels, barcodes and scanning

Every order has a **Shipping label** button that produces a 4x6 inch courier label with your logo, the delivery address, a COD or PAID panel showing what to collect, the contents, and the order number as both a barcode and a QR code. Download it as a PDF or print it. On an ordinary A4 printer choose "Fit to page".

Every size and colour already has its own SKU, and **Inventory > Print barcode labels** turns those into a sheet of stickers, forty to an A4 page. Set how many you need per item, or press "Match stock" to print one per piece you hold.

The **Scan** page uses your phone camera to read either code. Scan a parcel before it leaves, enter the courier and tracking number, and the order is marked as handed over, with the time recorded in its history. Scanning a product sticker instead shows what that item is and how many are in stock. If the camera isn't available you can type the code in by hand.

Cameras only work on a secure address, so scanning works on your GitHub Pages site and with Live Server, but not if you open the file directly from disk. Android and desktop Chrome read both the barcode and the QR code; iPhones read the QR code, which is why every label carries both.

## How profit is calculated

The total a customer pays is the subtotal, minus any discount, plus shipping, plus tax (0 unless you set a rate). Revenue is that total without the tax. Cost of goods is each product's cost per piece times the quantity sold. Gross profit is revenue minus cost of goods, and net profit (in Reports) is gross profit minus the expenses in the same period. Each order keeps its own prices and costs, so changing a product later never rewrites past profit. Cancelled and refunded orders don't count, and either can return the items to stock.

## Files

```
index.html               The page that loads everything
manifest.webmanifest     Lets phones "Add to Home Screen" with the PLAENS icon
firestore.rules          Security rules to paste into Firebase
assets/                  Logo files, app icons and fonts
css/styles.css           Styling: brand colours are at the top, animations at the bottom
js/firebase-config.js    Your Firebase settings (off until you switch it on)
js/server.js             The store engine: stock, orders, profit, receipts, storage and Firebase sync
js/app.js                The dashboard screens, PDF receipts and animations
js/vendor/               Firebase, PDF and EmailJS libraries (bundled so nothing loads from outside)
```

To change the receipt design, look for the `receipt` section in `js/server.js`. Animations respect the "reduce motion" setting on phones and computers.
