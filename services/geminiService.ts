
import { GoogleGenAI, Type } from "@google/genai";
import { Molecule, ReactionResult, ElementType } from '../types';
import { autoLayoutMolecule } from './layoutService';

const getClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key not found");
  }
  return new GoogleGenAI({ apiKey });
};

/**
 * Uses Gemini 3 to calculate scientifically accurate 3D coordinates.
 */
export const getAccurate3DStructure = async (molecule: Molecule): Promise<Molecule> => {
  const ai = getClient();
  
  if (molecule.atoms.length === 0) return molecule;

  const atomList = molecule.atoms.map(a => `ID:${a.id} Element:${a.element}`).join(', ');
  const bondList = molecule.bonds.map(b => `${b.sourceAtomId}-${b.targetAtomId} (Order:${b.order})`).join(', ');

  const systemInstruction = `
    You are a 3D Computational Chemistry Engine.
    Calculate VSEPR 3D coordinates (x, y, z) for this molecule.
    
    CRITICAL RULES:
    1. Do NOT put all atoms on a single plane or line.
    2. Use realistic bond lengths (~3.5 units).
    3. Tetrahedral centers (like C in CH4) must form a 3D tetrahedron, not a cross.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Structure for:\nAtoms: ${atomList}\nBonds: ${bondList}`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            atoms: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  x: { type: Type.NUMBER },
                  y: { type: Type.NUMBER },
                  z: { type: Type.NUMBER }
                },
                required: ["id", "x", "y", "z"]
              }
            }
          }
        }
      }
    });

    const data = JSON.parse(response.text || "{}");
    const newCoords = new Map<string, {x: number, y: number, z: number}>(
      (data.atoms || []).map((a: any) => [String(a.id), a])
    );

    const updatedAtoms = molecule.atoms.map(atom => {
      const coords = newCoords.get(atom.id);
      if (coords) {
        return { ...atom, x: Number(coords.x), y: Number(coords.y), z: Number(coords.z) };
      }
      return atom;
    });

    // Run auto-layout to refine the physics even if AI gave coords
    return autoLayoutMolecule({ ...molecule, atoms: updatedAtoms }, 0, 0);

  } catch (error) {
    console.error("3D Structure Error:", error);
    return autoLayoutMolecule(molecule, 400, 400); 
  }
};

/**
 * Identifies a molecule.
 */
export const identifyMolecule = async (molecule: Molecule): Promise<string> => {
  const ai = getClient();

  const atomList = molecule.atoms.map(a => `${a.element} (id:${a.id})`).join(', ');
  const bondList = molecule.bonds.map(b => `${b.sourceAtomId}-${b.targetAtomId} (order:${b.order})`).join(', ');
  
  const counts: Record<string, number> = {};
  molecule.atoms.forEach(a => {
    counts[a.element] = (counts[a.element] || 0) + 1;
  });
  const formula = Object.entries(counts).map(([el, count]) => `${el}${count > 1 ? count : ''}`).join('');

  const systemInstruction = `
    Identify the common name of this molecule.
    If no common name, use IUPAC.
    Return ONLY the name string.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Atoms: ${atomList}\nBonds: ${bondList}\nFormula Hint: ${formula}`,
      config: {
        systemInstruction,
        responseMimeType: "text/plain",
      }
    });
    
    let name = response.text?.trim();
    if (!name || name.length > 50) return formula;
    return name;
  } catch (error) {
    return formula;
  }
};

/**
 * Generates reaction prediction.
 */
export const simulateReaction = async (reactants: Molecule[]): Promise<ReactionResult> => {
  const ai = getClient();

  const reactantDescriptions = reactants.map(r => {
    const counts: Record<string, number> = {};
    r.atoms.forEach(a => {
      counts[a.element] = (counts[a.element] || 0) + 1;
    });
    const formula = Object.entries(counts).map(([el, count]) => `${el}${count > 1 ? count : ''}`).join('');
    return `${r.name || 'Unknown Molecule'} (${formula})`;
  }).join(' + ');

  const systemInstruction = `
    You are an expert computational chemist. 
    1. Predict the reaction.
    2. Balance the equation.
    3. Generate product structures.
    
    IMPORTANT: Return a connectivity graph (atoms/bonds). 
    The 'x, y, z' coordinates are optional but if provided, must not be linear for 3D molecules.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Reactants: ${reactantDescriptions}`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            equation: { type: Type.STRING },
            explanation: { type: Type.STRING },
            products: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  atoms: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        element: { type: Type.STRING },
                      },
                      required: ["id", "element"]
                    }
                  },
                  bonds: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        source: { type: Type.STRING },
                        target: { type: Type.STRING },
                        order: { type: Type.INTEGER }
                      },
                      required: ["source", "target", "order"]
                    }
                  }
                },
                required: ["name", "atoms", "bonds"]
              }
            }
          },
          required: ["equation", "explanation", "products"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");
    
    const data = JSON.parse(text);

    const products: Molecule[] = (data.products || []).map((p: any, index: number) => {
      const validAtoms = (p.atoms || []).filter((a: any) => a.id && a.element);
      const atomIdSet = new Set(validAtoms.map((a: any) => String(a.id)));

      const validBonds = (p.bonds || []).filter((b: any) => 
        atomIdSet.has(String(b.source)) && atomIdSet.has(String(b.target))
      );

      // Create raw molecule with NO coordinates initially (0,0,0)
      // This triggers the "needsScramble" logic in autoLayoutMolecule
      const rawMolecule = {
        id: `product-${index}-${Date.now()}`,
        name: p.name || "Product",
        atoms: validAtoms.map((a: any) => ({
          id: String(a.id),
          element: a.element as ElementType, 
          x: 0, 
          y: 0,
          z: 0
        })),
        bonds: validBonds.map((b: any, bIndex: number) => ({
          id: `bond-${index}-${bIndex}`,
          sourceAtomId: String(b.source),
          targetAtomId: String(b.target),
          order: b.order || 1
        }))
      };

      // The layout service will see Z range is 0 and aggressively scramble it into 3D
      // Then apply physics to relax it into the correct shape
      return autoLayoutMolecule(rawMolecule, 600, 400);
    });

    return {
      equation: data.equation || "Reaction Complete",
      explanation: data.explanation || "The reactants formed new products.",
      products
    };

  } catch (error) {
    console.error("Gemini Error:", error);
    throw new Error("Failed to simulate reaction. Please try again.");
  }
};
