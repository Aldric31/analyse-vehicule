const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Configuration
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Client Anthropic (utilise ANTHROPIC_API_KEY depuis les variables d'environnement)
const anthropic = new Anthropic();

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

Si les informations fournies sont insuffisantes pour produire une analyse utile, réponds :
{
  "erreur": "Les informations fournies sont insuffisantes pour produire une analyse factuelle utile."
}

IMPORTANT : Réponds UNIQUEMENT avec le JSON, sans texte avant ou après.`;

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

    // Construction du message utilisateur
    let userMessage = "Analyse ce dossier d'achat de véhicule :\n\n";

    if (annonceLink) {
      userMessage += `LIEN DE L'ANNONCE :\n${annonceLink}\n\n`;
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

// Route de santé
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
