# OARflow

Static website for Pasternack Pest Management.

## Project Structure

- `index.html` - Home page
- `services.html` - Services and pricing
- `about.html` - Company story and approach
- `contact.html` - Quote request/contact page
- `assets/css/styles.css` - Site styles
- `assets/js/script.js` - Navigation, reveal, FAQ, and form interactions
- `assets/img/` - Logo and favicon assets

## Local Preview

Open `index.html` directly in a browser, or serve the folder locally:

```bash
python3 -m http.server 4173
```

Then visit `http://localhost:4173`.

## Notes

The contact form currently validates in the browser and shows a confirmation message, but it does not send submissions to an email inbox or CRM yet. Connect `contact.html` to a form handler before using it for live lead capture.
