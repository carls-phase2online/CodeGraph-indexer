// src/analyzer/python-parser.ts
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs'; // Import synchronous existsSync

// ESM equivalent of __dirname — resolves to dist/analyzer/ at runtime
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { createContextLogger } from '../utils/logger.js';
import { ParserError, FileSystemError } from '../utils/errors.js';
import { FileInfo } from '../scanner/file-scanner.js';
import { AstNode, RelationshipInfo, SingleFileParseResult, InstanceCounter } from './types.js';
import { ensureTempDir, getTempFilePath, generateInstanceId, generateEntityId } from './parser-utils.js'; // Reusing utils

const logger = createContextLogger('PythonAstParser');

// Interface matching the JSON structure output by python_parser.py
interface PythonParseOutput extends SingleFileParseResult {
    error?: string; // Optional error field
}

/**
 * Parses Python files using an external Python script (`python_parser.py`)
 * and translates the output into the common AstNode/RelationshipInfo format.
 */
export class PythonAstParser {
    private pythonExecutable: string; // Path to python executable (e.g., 'python' or 'python3')

    constructor(pythonExecutable: string = 'python') { // Default to 'python'
        this.pythonExecutable = pythonExecutable;
        logger.debug(`Python AST Parser initialized with executable: ${this.pythonExecutable}`);
    }

    /**
     * Parses a single Python file by executing the external script.
     * @param file - FileInfo object for the Python file.
     * @returns A promise resolving to the path of the temporary result file.
     * @throws {ParserError} If the Python script fails or returns an error.
     */
    async parseFile(file: FileInfo, basePath?: string): Promise<string> {
        logger.info(`[PythonAstParser] Starting Python parsing for: ${file.name}`);
        await ensureTempDir(); // Ensure temp directory exists

        const tempFilePath = getTempFilePath(file.path);
        const absoluteFilePath = path.resolve(file.path); // Ensure absolute path for the script
        // Compute a repo-relative path when basePath is provided. If the file is NOT inside
        // basePath (e.g., caller passed an unrelated --relative-to), fall back to the absolute
        // path rather than storing a `../../../` traversal sequence in Neo4j node IDs.
        const normalizedFilePath = (() => {
            if (!basePath) return absoluteFilePath.replace(/\\/g, '/');
            const rel = path.relative(basePath, absoluteFilePath).replace(/\\/g, '/');
            return rel.startsWith('../') || path.isAbsolute(rel) ? absoluteFilePath.replace(/\\/g, '/') : rel;
        })();

        try {
            const outputJson = await this.runPythonScript(absoluteFilePath);
            const result: PythonParseOutput = JSON.parse(outputJson);

            if (result.error) {
                throw new ParserError(`Python script reported error for ${file.path}: ${result.error}`);
            }

            // Basic validation of the received structure (can be expanded)
            if (!result.filePath || !Array.isArray(result.nodes) || !Array.isArray(result.relationships)) {
                 throw new ParserError(`Invalid JSON structure received from python_parser.py for ${file.path}`);
            }

            // --- DEBUG LOG: count-only summary (avoid dumping the full AST to logs) ---
            logger.debug(`[PythonAstParser] Parsed ${file.name}: ${result.nodes.length} nodes, ${result.relationships.length} rels`);
            // --- END DEBUG LOG ---


            // --- Data Transformation (if needed) ---
            // The python script is designed to output data largely matching SingleFileParseResult.
            // If transformations were needed (e.g., renaming fields, calculating LOC), they'd happen here.
            // For now, we assume the structure is compatible. We just need to add instance IDs.

            const instanceCounter: InstanceCounter = { count: 0 };
            const finalResult: SingleFileParseResult = {
                filePath: normalizedFilePath, // Use normalized (possibly relative) path
                nodes: result.nodes.map(node => ({
                    ...node,
                    filePath: normalizedFilePath, // Override script-provided path with normalized version
                    // Generate instance ID based on Python output location/name
                    id: generateInstanceId(instanceCounter, node.kind.toLowerCase(), node.name, { line: node.startLine, column: node.startColumn }),
                    createdAt: new Date().toISOString(), // Add timestamp
                })),
                relationships: result.relationships.map(rel => ({
                    ...rel,
                     // Generate instance ID for relationship
                     id: generateInstanceId(instanceCounter, rel.type.toLowerCase(), `${rel.sourceId}:${rel.targetId}`), // Simple ID for rel
                     createdAt: new Date().toISOString(), // Add timestamp
                     weight: rel.weight ?? 1, // Default weight
                })),
            };


            await fs.writeFile(tempFilePath, JSON.stringify(finalResult, null, 2));
            logger.info(`[PythonAstParser] Pass 1 completed for: ${file.name}. Nodes: ${finalResult.nodes.length}, Rels: ${finalResult.relationships.length}. Saved to ${path.basename(tempFilePath)}`);
            return tempFilePath;

        } catch (error: any) {
            logger.error(`[PythonAstParser] Error during Python Pass 1 for ${file.path}`, {
                 errorMessage: error.message,
                 stack: error.stack?.substring(0, 500)
            });
            // Attempt to clean up temp file if created
            try { await fs.unlink(tempFilePath); } catch { /* ignore cleanup error */ }
            // Re-throw as a ParserError
            throw new ParserError(`Failed Python Pass 1 parsing for ${file.path}`, { originalError: error });
        }
    }

    /**
     * Executes the python_parser.py script.
     * @param filePath - Absolute path to the Python file to parse.
     * @returns A promise resolving to the JSON string output from the script.
     */
    private runPythonScript(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            // --- Debug: Check if Node.js can see the file ---
            const fileExists = existsSync(filePath);
            logger.debug(`[PythonAstParser] Node.js check: File '${filePath}' exists? ${fileExists}`);
            if (!fileExists) {
                return reject(new ParserError(`Node.js cannot find the file before spawning Python: ${filePath}`));
            }
            // --- End Debug ---
            const scriptPath = path.resolve(__dirname, 'parsers', 'python_parser.py');
            logger.debug(`[PythonAstParser] Executing: ${this.pythonExecutable} "${scriptPath}" "${filePath}"`);

            const childProcess = spawn(this.pythonExecutable, [scriptPath, filePath], { cwd: process.cwd() }); // Explicitly set CWD
 // Renamed variable

            // Cap stdout/stderr growth so a pathological Python output (auto-generated
            // code with thousands of symbols) can't exhaust Node.js heap. When exceeded,
            // kill the child and reject — the file gets skipped rather than OOM'ing the run.
            const MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50 MB per file
            let stdoutData = '';
            let stderrData = '';
            let killed = false;

            const killIfOverBudget = (bytes: number, stream: 'stdout' | 'stderr') => {
                if (killed || bytes <= MAX_OUTPUT_BYTES) return;
                killed = true;
                childProcess.kill();
                reject(new ParserError(
                    `Python script ${stream} for ${path.basename(filePath)} exceeded ${MAX_OUTPUT_BYTES} bytes; file skipped`,
                ));
            };

            childProcess.stdout.on('data', (data) => {
 // Use childProcess
                stdoutData += data.toString();
                killIfOverBudget(stdoutData.length, 'stdout');
            });

            childProcess.stderr.on('data', (data) => {
 // Use childProcess
                stderrData += data.toString();
                killIfOverBudget(stderrData.length, 'stderr');
            });

            childProcess.on('error', (err) => {
 // Use childProcess
                 logger.error(`[PythonAstParser] Failed to start python script: ${err.message}`);
                reject(new ParserError(`Failed to start python script '${this.pythonExecutable}'. Is Python installed and in PATH?`, { originalError: err }));
            });

            childProcess.on('close', (code) => {
 // Use childProcess
                logger.debug(`[PythonAstParser] Python script finished for ${path.basename(filePath)} with code ${code}. Stderr: ${stderrData.trim()}`);
                if (code === 0) {
                    if (stderrData) {
                         logger.warn(`[PythonAstParser] Python script produced stderr output (but exited OK): ${stderrData.trim()}`);
                    }
                    resolve(stdoutData);
                } else {
                    // Try to parse stderr for a JSON error message from the script
                    try {
                        const errorJson = JSON.parse(stderrData);
                        if (errorJson.error) {
                             reject(new ParserError(`Python script error: ${errorJson.error}`));
                             return;
                        }
                    } catch { /* Ignore JSON parse error on stderr */ }
                    // Fallback error
                    reject(new ParserError(`Python script exited with code ${code}. Stderr: ${stderrData.trim()}`));
                }
            });
        });
    }
}