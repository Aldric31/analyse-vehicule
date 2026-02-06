const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Configuration
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Client Anthropic (utilise ANTHROPIC_API_KEY depuis les variables d'environnement)
const anthropic = new Anthropic();

// --- Browser singleton ---
let browser = null;

async function getBrowser() {
  if (browser && browser.connected) {
    return browser;
  }

  console.log('Lancement du navigateur Chrome...');
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
      '--no-zygote',
    ],
  });

  browser.on('disconnected', () => {
    console.log('Browser déconnecté, sera relancé à la prochaine requête');
    browser = null;
  });

  console.log('Chrome lancé avec succès');
  return browser;
}

// Prompt système pour l'analyse
const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'analyse factuelle de dossiers d'achat de véhicules de passion ou de collection.

Ton rôle est de produire une lecture de cohérence basée UNIQUEMENT sur les éléments fournis par l'utilisateur.

RÈGLES STRICTES :
- Tu ne donnes JAMAIS d'avis d'achat
- Tu ne certifies JAMAIS l'état du véhicule
- Tu ne remplaces JAMAIS une expertise mécanique
- Tu ne garantis RIEN
- Tu restes TOUJOURS factuel et neutre
- Tu n'utilises JAMAIS de jargon automobile complexe
- Tu ne fais AUCUNE accusation envers le vendeur
- Tu formules les incohérences de manière neutre : "X est annoncé, mais Y suggère autre chose"

FORMAT DE RÉPONSE (respecte STRICTEMENT cette structure JSON) :
{
  "vehicule": {
    "modele": "Marque et modèle du véhicule (ou null si non identifiable)",
    "annee": "Année du véhicule (ou null si non identifiable)",
    "kilometrage": "Kilométrage indiqué (ou null si non mentionné)",
    "prix": "Prix demandé (ou null si non mentionné)"
  },
  "elementsCoherents": [
    "Description factuelle d'un élément cohérent",
    "..."
  ],
  "incoherencesPotentielles": [
    "Description neutre d'une incohérence potentielle",
    "..."
  ],
  "zonesOmbre": [
    "Information manquante ou insuffisante",
    "..."
  ],
  "questionsAPoser": [
    "Question factuelle à poser au vendeur",
    "..."
  ],
  "lectureGlobale": "2-3 phrases maximum résumant la lecture de cohérence, SANS recommandation d'achat."
}

Pour le champ "vehicule", extrais les informations directement depuis les éléments fournis (annonce, description, échanges, documents, photos). Si une information n'est pas trouvable, mets null.

Si les informations fournies sont insuffisantes pour produire une analyse utile, réponds :
{
  "erreur": "Les informations fournies sont insuffisantes pour produire une analyse factuelle utile."
}

IMPORTANT : Réponds UNIQUEMENT avec le JSON, sans texte avant ou après.`;

// Fonction de scraping du contenu d'une annonce avec Puppeteer
async function fetchAnnonceContent(url) {
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Bloquer images, fonts, CSS pour accélérer le chargement
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // User-agent réaliste
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigation — networkidle2 attend que le JS finisse de rendre
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Accepter les popups de cookies (patterns courants)
    const cookieSelectors = [
      '[id*="cookie"] button', '[class*="cookie"] button',
      '[id*="consent"] button', '[class*="consent"] button',
      '[id*="onetrust"] button', '#onetrust-accept-btn-handler',
      'button[id*="accept"]', 'button[class*="accept"]',
      'button[id*="agree"]', 'button[class*="agree"]',
      '.cmp-accept', '[data-testid="accept-all"]',
    ];
    for (const sel of cookieSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          console.log(`Cookie popup fermé via: ${sel}`);
          await new Promise(r => setTimeout(r, 1000));
          break;
        }
      } catch {}
    }

    // Attendre que le vrai contenu soit rendu (h1, prix, ou description)
    await page.waitForSelector('h1, [class*="price"], [class*="Price"], [class*="detail"]', { timeout: 8000 }).catch(() => {});

    // Extraire le contenu depuis le DOM réel
    const result = await page.evaluate(() => {
      // Supprimer les éléments parasites
      const selectorsToRemove = [
        'script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript', 'svg',
        '[role="navigation"]', '[role="banner"]', '[class*="cookie"]', '[class*="Cookie"]',
        '[class*="consent"]', '[class*="Consent"]', '[class*="popup"]', '[class*="Popup"]',
        '[class*="modal"]', '[class*="Modal"]', '[class*="banner"]', '[class*="Banner"]',
        '[class*="overlay"]', '[class*="Overlay"]',
      ];
      selectorsToRemove.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });

      const parts = [];

      // Titre de la page
      const title = document.title?.trim();
      if (title) parts.push('TITRE: ' + title);

      // Meta description
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content');
      if (metaDesc) parts.push('DESCRIPTION META: ' + metaDesc.trim());

      // Prix
      document.querySelectorAll('[class*="price"], [class*="prix"], [class*="Price"], [data-qa="adview_price"]').forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length < 100) parts.push('PRIX: ' + text);
      });

      // Titre de l'annonce
      document.querySelectorAll('h1, [class*="title"], [class*="titre"], [data-qa="adview_title"]').forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length > 3 && text.length < 200) parts.push('TITRE ANNONCE: ' + text);
      });

      // Description
      document.querySelectorAll('[class*="description"], [class*="Description"], [data-qa="adview_description"], [class*="content"], [class*="body"]').forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length > 20) parts.push('DESCRIPTION: ' + text);
      });

      // Caractéristiques / spécifications
      document.querySelectorAll('[class*="criteria"], [class*="feature"], [class*="detail"], [class*="specification"], [class*="attribute"], dl, table').forEach(el => {
        const text = el.textContent?.trim().replace(/\s+/g, ' ');
        if (text && text.length > 10 && text.length < 1000) parts.push('CARACTÉRISTIQUES: ' + text);
      });

      // Fallback: si peu de contenu extrait, prendre le body
      if (parts.length <= 2) {
        const bodyText = document.body?.textContent?.replace(/\s+/g, ' ')?.trim();
        if (bodyText) parts.push('CONTENU PAGE: ' + bodyText);
      }

      return parts.join('\n\n');
    });

    // Limiter à 5000 caractères
    let content = result;
    if (content.length > 5000) {
      content = content.substring(0, 5000) + '\n[... contenu tronqué]';
    }

    if (content.trim().length < 50) {
      console.log('Contenu extrait trop court, considéré comme échec');
      return null;
    }

    console.log(`Contenu annonce extrait: ${content.length} caractères`);
    console.log(`Aperçu: ${content.substring(0, 200)}`);
    return content;

  } catch (error) {
    console.log(`Erreur scraping annonce: ${error.message}`);
    return null;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

// Route principale d'analyse
app.post('/api/analyze', upload.fields([
  { name: 'documents', maxCount: 10 },
  { name: 'photos', maxCount: 20 }
]), async (req, res) => {
  console.log('Requête reçue:', new Date().toISOString());
  try {
    const { annonceLink, description } = req.body;
    console.log('Description length:', description?.length || 0);
    console.log('Annonce link:', annonceLink || 'none');
    const documents = req.files?.documents || [];
    const photos = req.files?.photos || [];

    // Vérification des données minimales
    const hasDescription = description && description.trim().length > 20;
    const hasDocuments = documents.length > 0;
    const hasPhotos = photos.length > 0;
    const hasLink = annonceLink && annonceLink.trim().length > 10;

    if (!hasDescription && !hasDocuments && !hasPhotos && !hasLink) {
      return res.json({
        erreur: "Les informations fournies sont insuffisantes pour produire une analyse factuelle utile."
      });
    }

    // Scraping du contenu de l'annonce si un lien est fourni
    let annonceContent = null;
    if (annonceLink && annonceLink.trim().length > 10) {
      console.log('Scraping annonce avec Puppeteer:', annonceLink);
      annonceContent = await fetchAnnonceContent(annonceLink.trim());
    }

    // Construction du message utilisateur
    let userMessage = "Analyse ce dossier d'achat de véhicule :\n\n";

    if (annonceLink) {
      if (annonceContent) {
        userMessage += `CONTENU DE L'ANNONCE (récupéré depuis ${annonceLink}) :\n${annonceContent}\n\n`;
      } else {
        userMessage += `LIEN DE L'ANNONCE (contenu non récupérable) : ${annonceLink}\n\n`;
      }
    }

    if (description) {
      userMessage += `DESCRIPTION ET ÉCHANGES :\n${description}\n\n`;
    }

    if (documents.length > 0) {
      userMessage += `DOCUMENTS FOURNIS : ${documents.length} fichier(s)\n`;
      documents.forEach(doc => {
        userMessage += `- ${doc.originalname}\n`;
      });
      userMessage += "\n";
    }

    if (photos.length > 0) {
      userMessage += `PHOTOS FOURNIES : ${photos.length} photo(s)\n`;
      photos.forEach(photo => {
        userMessage += `- ${photo.originalname}\n`;
      });
      userMessage += "\n";
    }

    // Préparation du contenu pour Claude (texte + images si présentes)
    const content = [];

    // Ajouter les images (photos et documents image)
    const imageFiles = [...photos, ...documents.filter(d =>
      d.mimetype.startsWith('image/')
    )];

    for (const img of imageFiles.slice(0, 10)) { // Limiter à 10 images
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimetype,
          data: img.buffer.toString('base64')
        }
      });
    }

    // Ajouter le texte
    content.push({
      type: "text",
      text: userMessage
    });

    // Appel à l'API Claude
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: content
        }
      ]
    });

    // Extraction de la réponse
    const responseText = response.content[0].text;

    // Parse du JSON
    let analysisResult;
    try {
      analysisResult = JSON.parse(responseText);
    } catch (parseError) {
      // Si le JSON est mal formé, tenter d'extraire
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Réponse invalide de l'IA");
      }
    }

    res.json(analysisResult);

  } catch (error) {
    console.error('Erreur complète:', error.message);
    console.error('Stack:', error.stack);
    if (error.response) {
      console.error('Response:', error.response);
    }
    res.status(500).json({
      erreur: "Une erreur s'est produite lors de l'analyse. Veuillez réessayer."
    });
  }
});

// Route de santé avec statut du browser
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    browser: browser && browser.connected ? 'connected' : 'disconnected',
  });
});

// Shutdown propre : fermer Chrome avant arrêt du container
process.on('SIGTERM', async () => {
  console.log('SIGTERM reçu, fermeture de Chrome...');
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT reçu, fermeture de Chrome...');
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});

// Démarrage du serveur + lancement du browser
app.listen(PORT, async () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  try {
    await getBrowser();
    console.log('Browser prêt pour le scraping');
  } catch (err) {
    console.error('Impossible de lancer Chrome au démarrage:', err.message);
    console.log('Le browser sera relancé à la première requête de scraping');
  }
});
