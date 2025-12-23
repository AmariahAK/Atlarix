/**
 * Code Refactoring Tool
 * ====================
 * Automated code refactoring operations
 */

import { ToolRegistry, ToolCategory } from "./registry";
import fs from "fs/promises";

// ============================================
// REFACTOR CODE
// ============================================

/**
 * Apply common refactoring patterns to code
 */
ToolRegistry.register({
    name: "refactor_code",
    category: ToolCategory.CODE,
    description: "Apply refactoring pattern (extract-function, rename-variable, etc.)",
    parameters: {
        filepath: {
            type: "string",
            description: "File to refactor",
            required: true,
        },
        pattern: {
            type: "string",
            description: "Refactoring pattern: extract-function, rename-variable, inline-variable, extract-constant",
            required: true,
        },
        options: {
            type: "object",
            description: "Pattern-specific options",
            required: true,
        },
    },
    cost: 10,
    handler: async (params: {
        filepath: string;
        pattern: string;
        options: any;
    }) => {
        try {
            const content = await fs.readFile(params.filepath, "utf-8");
            let newContent = content;

            switch (params.pattern) {
                case "rename-variable":
                    newContent = renameVariable(
                        content,
                        params.options.oldName,
                        params.options.newName
                    );
                    break;

                case "extract-function":
                    newContent = extractFunction(
                        content,
                        params.options.startLine,
                        params.options.endLine,
                        params.options.functionName
                    );
                    break;

                case "inline-variable":
                    newContent = inlineVariable(content, params.options.variableName);
                    break;

                case "extract-constant":
                    newContent = extractConstant(
                        content,
                        params.options.value,
                        params.options.constantName
                    );
                    break;

                default:
                    return {
                        success: false,
                        error: `Unknown refactoring pattern: ${params.pattern}`,
                    };
            }

            // Write the refactored code
            await fs.writeFile(params.filepath, newContent, "utf-8");

            return {
                success: true,
                filepath: params.filepath,
                pattern: params.pattern,
                changes_made: content !== newContent,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function renameVariable(code: string, oldName: string, newName: string): string {
    // Simple word boundary replacement
    const regex = new RegExp(`\\b${oldName}\\b`, "g");
    return code.replace(regex, newName);
}

function extractFunction(
    code: string,
    startLine: number,
    endLine: number,
    functionName: string
): string {
    const lines = code.split("\n");

    // Extract the code block
    const extractedLines = lines.slice(startLine - 1, endLine);
    const extractedCode = extractedLines.join("\n");

    // Create new function
    const newFunction = `\nfunction ${functionName}() {\n${extractedCode}\n}\n`;

    // Replace extracted code with function call
    const replacement = `${functionName}();`;

    lines.splice(startLine - 1, endLine - startLine + 1, replacement);

    // Add function at the end
    lines.push(newFunction);

    return lines.join("\n");
}

function inlineVariable(code: string, variableName: string): string {
    const lines = code.split("\n");
    let value: string | null = null;
    let declarationIndex = -1;

    // Find variable declaration
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(
            new RegExp(`(?:const|let|var)\\s+${variableName}\\s*=\\s*(.+);`)
        );
        if (match) {
            value = match[1];
            declarationIndex = i;
            break;
        }
    }

    if (value === null) {
        return code; // Variable not found
    }

    // Replace all usages with the value
    const regex = new RegExp(`\\b${variableName}\\b`, "g");
    let newCode = code.replace(regex, value);

    // Remove the declaration line
    const newLines = newCode.split("\n");
    newLines.splice(declarationIndex, 1);

    return newLines.join("\n");
}

function extractConstant(code: string, value: string, constantName: string): string {
    // Find all occurrences of the value
    const regex = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");

    // Replace with constant name
    const newCode = code.replace(regex, constantName);

    // Add constant declaration at the top
    const lines = newCode.split("\n");

    // Find first import or code line
    let insertIndex = 0;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("import") && lines[i].trim()) {
            insertIndex = i;
            break;
        }
    }

    lines.splice(insertIndex, 0, `const ${constantName} = ${value};`, "");

    return lines.join("\n");
}
