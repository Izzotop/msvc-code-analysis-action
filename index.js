"use strict";

import { getInput, info, warning, debug, setOutput, isDebug, setFailed } from '@actions/core';
import { exec as _exec, getExecOutput } from '@actions/exec';
import { existsSync, readdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { mkdirP, which } from '@actions/io';
import { normalize, join, isAbsolute, basename, dirname } from 'path';
import { fileSync } from 'tmp';
import { argStringToArray } from '@actions/exec/lib/toolrunner';

const CMakeApiClientName = "client-msvc-ca-action";
// Paths relative to absolute path to cl.exe
const RelativeRulesetPath = '..\\..\\..\\..\\..\\..\\..\\..\\Team Tools\\Static Analysis Tools\\Rule Sets';
const RelativeToolsetPath = '..\\..\\..\\..';
const RelativeCommandPromptPath = '..\\..\\..\\..\\..\\..\\..\\Auxiliary\\Build\\vcvarsall.bat';

/**
 * Validate if the given directory both exists and is non-empty.
 * @param {string} targetDir directory to test
 * @returns {boolean} true if the directory is empty
 */
function isDirectoryEmpty(targetDir) {
  return !targetDir || !existsSync(targetDir) || (readdirSync(targetDir).length) == 0;
}

/**
 * Validate if the targetDir is either equal or a sub-directory of any path in parentDirs
 * @param {string[]} parentDirs parent directories
 * @param {string} targetDir directory to test
 * @returns {boolean} true if a sub-directory is found
 */
function containsSubdirectory(parentDirs, targetDir) {
  const normalizedTarget = normalize(targetDir);
  return parentDirs.some((parentDir) => normalizedTarget.startsWith(normalize(parentDir)));
}

/**
 * Get normalized relative path from a given file/directory.
 * @param {string} fromPath path to join relative path to
 * @param {string} relativePath relative path to append
 * @returns normalized path
 */
function getRelativeTo(fromPath, relativePath) {
  return normalize(join(fromPath, relativePath))
}

/**
 * Validate and resolve path by making non-absolute paths relative to GitHub
 * repository root.
 * @param {string} unresolvedPath path to resolve
 * @returns the resolved absolute path
 */
function resolvePath(unresolvedPath) {
  return normalize(isAbsolute(unresolvedPath) ? 
    unresolvedPath : join(process.env.GITHUB_WORKSPACE, unresolvedPath));
}

/**
 * Validate and resolve action input path by making non-absolute paths relative to
 * GitHub repository root.
 * @param {string} input name of GitHub action input variable
 * @param {boolean} required if true the input must be non-empty
 * @returns the absolute path to the input path if specified
 */
function resolveInputPath(input, required = false) {
  let inputPath = getInput(input);
  if (!inputPath) {
    if (required) {
      throw new Error(input + " input path can not be empty.");
    }

    return undefined;
  }

  return resolvePath(inputPath, required);
}

/**
 * Validate and resolve action input paths making non-absolute paths relative to
 * GitHub repository root. Paths are seperated by the provided string.
 * @param {string} input name of GitHub action input variable
 * @param {boolean} required if true the input must be non-empty
 * @returns the absolute path to the input path if specified
 */
function resolveInputPaths(input, required = false, seperator = ';') {
  const inputPaths = getInput(input);
  if (!inputPaths) {
    if (required) {
      throw new Error(input + " input paths can not be empty.");
    }

    return [];
  }

  return inputPaths.split(seperator)
    .map((inputPath) => resolvePath(inputPath))
    .filter((inputPath) => inputPath);
}

/**
 * Create a query file for the CMake API
 * @param {string} apiDir CMake API directory '.cmake/api/v1'
 */
async function createApiQuery(apiDir) {
  const queryDir = join(apiDir, "query", CMakeApiClientName);
  if (!existsSync(queryDir)) {
    await mkdirP(queryDir);
  }

  const queryFile = join(queryDir, "query.json");
  const queryData = {
    "requests": [
      { kind: "codemodel", version: 2 },
      { kind: "toolchains", version: 1 }
  ]};

  try {
    writeFileSync(queryFile, JSON.stringify(queryData), 'utf-8');
  } catch (err) {
    throw new Error("Failed to write query.json file for CMake API.", err);
  }
}

/**
 * Read and parse the given JSON reply file.
 * @param {string} replyFile absolute path to JSON reply
 * @returns parsed JSON data of the reply file
 */
function parseReplyFile(replyFile) {
  if (!existsSync(replyFile)) {
    throw new Error("Failed to find CMake API reply file: " + replyFile);
  }

  let jsonData = readFileSync(replyFile, (err) => {
    if (err) {
      throw new Error("Failed to read CMake API reply file: " + replyFile, err);
    }
  });

  return JSON.parse(jsonData);
}

/**
 * Get the JSON filepath for the given response kind.
 * @param {string} replyDir CMake API directory for replies '.cmake/api/v1/reply'
 * @param {object} indexReply parsed JSON data from index-xxx.json reply
 * @param {string} kind the kind of response to search for
 * @returns the absolute path to the JSON response file, null if not found
 */
function getResponseFilepath(replyDir, clientResponses, kind) {
  const response = clientResponses.find((response) => response["kind"] == kind);
  return response ? join(replyDir, response.jsonFile) : null;
}

/**
 * Information extracted from CMake API index reply which details all other requested responses.
 * @param {string} replyDir CMake API directory for replies '.cmake/api/v1/reply'
 * @param {object} indexReply parsed JSON data from index-xxx.json reply
 */
function ReplyIndexInfo(replyDir, indexReply) {
  const clientResponses = indexReply.reply[CMakeApiClientName]["query.json"].responses;
  this.codemodelResponseFile = getResponseFilepath(replyDir, clientResponses, "codemodel");
  this.toolchainsResponseFile = getResponseFilepath(replyDir, clientResponses, "toolchains");
  this.version = indexReply.cmake.version.string;
}

/**
 * Load the information needed from the reply index file for the CMake API
 * @param {string} apiDir CMake API directory '.cmake/api/v1'
 * @returns ReplyIndexInfo info extracted from index-xxx.json reply
 */
function getApiReplyIndex(apiDir) {
  const replyDir = join(apiDir, "reply");

  let indexFilepath;
  if (existsSync(replyDir)) {
    for (const filename of readdirSync(replyDir)) {
      if (filename.startsWith("index-")) {
        // get the most recent index query file (ordered lexicographically)
        const filepath = join(replyDir, filename);
        if (!indexFilepath || filepath > indexFilepath) {
          indexFilepath = filepath;
        }
      };
    }
  }

  if (!indexFilepath) {
    throw new Error("Failed to find CMake API index reply file.");
  }

  const indexReply = parseReplyFile(indexFilepath);
  const replyIndexInfo = new ReplyIndexInfo(replyDir, indexReply);

  info(`Loaded '${indexFilepath}' reply generated from CMake API.`);

  return replyIndexInfo;
}

/**
   * Load reply data from the CMake API. This will:
   *  - Create a query file in cmake API directory requesting data needed
   *  - Re-run CMake on build directory to generate reply data
   *  - Extract required information from the index-xxx.json reply
   *  - Validate the version of CMake to ensure required reply data exists
   * @param {string} buildRoot build directory of CMake project
   * @return ReplyIndexInfo info extracted from index-xxx.json reply
   */
async function loadCMakeApiReplies(buildRoot) {
  if (isDirectoryEmpty(buildRoot)) {
    throw new Error("CMake build root must exist, be non-empty and be configured with CMake");
  }

  // validate CMake can be found on the PATH
  await which("cmake", true);

  // create CMake API query file for the generation of replies needed
  const apiDir = join(buildRoot, ".cmake/api/v1");
  await createApiQuery(apiDir);

  // regenerate CMake build directory to acquire CMake file API reply
  info(`Running CMake to generate reply data.`);
  try {
    await _exec("cmake", [ buildRoot ])
  } catch (err) {
    throw new Error(`CMake failed to reconfigure project with error: ${err}`);
  }

  // load reply index generated from the CMake Api
  const replyIndexInfo = getApiReplyIndex(apiDir);
  if (replyIndexInfo.version < "3.20.5") {
    throw new Error("Action requires CMake version >= 3.20.5");
  }

  return replyIndexInfo;
}

/**
 * Information on compiler include path.
 * @param {string} path the absolute path to the include directory
 * @param {boolean} isSystem true if this should be treated as a CMake SYSTEM path
 */
function IncludePath(path, isSystem) {
  this.path = path;
  this.isSystem = isSystem;
}

/**
 * Information about the language and compiler being used to compile a source file.
 * @param {object} toolchain ReplyIndexInfo info extracted from index-xxx.json reply
 */
function ToolchainInfo(toolchain) {
  this.language = toolchain.language;
  this.path = toolchain.compiler.path;
  this.version = toolchain.compiler.version;
  this.includes = (toolchain.compiler.implicit.includeDirectories || []).map(
    (include) => new IncludePath(include, true));

  // extract toolset-version & host/target arch from folder layout in VS
  this.toolsetVersion = basename(getRelativeTo(this.path, RelativeToolsetPath));
  const targetDir = dirname(this.path);
  const hostDir = dirname(targetDir);
  this.targetArch = basename(targetDir);
  debug(`Host dir ${basename(hostDir)}`);
  debug(`Target Arch ${this.targetArch}`);
  switch (basename(hostDir)) {
    case 'Hostx86':
      this.hostArch = 'x86';
      break;
    case 'Hostx64':
      this.hostArch = 'x64';
      break;
    default:
      throw new Error('Unknown MSVC toolset layout');
  }
}

/**
 * Parse the toolchain-xxx.json file to find information on any MSVC toolchains used. If none are
 * found issue an error.
 * @param {ReplyIndexInfo} replyIndexInfo ReplyIndexInfo info extracted from index-xxx.json reply
 * @returns Toolchain info extracted from toolchain-xxx.json
 */
function loadToolchainMap(replyIndexInfo) {
  if (!existsSync(replyIndexInfo.toolchainsResponseFile)) {
    throw new Error("Failed to load toolchains response from CMake API");
  }

  const toolchainMap = {};
  const toolchains = parseReplyFile(replyIndexInfo.toolchainsResponseFile);
  const cToolchain = toolchains.toolchains.find(
    (t) => t.language == "C" && t.compiler.id == "MSVC");
  if (cToolchain) {
    toolchainMap[cToolchain.language] = new ToolchainInfo(cToolchain);
  }

  const cxxToolchain = toolchains.toolchains.find(
    (t) => t.language == "CXX" && t.compiler.id == "MSVC");
  if (cxxToolchain) {
    toolchainMap[cxxToolchain.language] = new ToolchainInfo(cxxToolchain);
  }


  if (Object.keys(toolchainMap).length === 0) {
    throw new Error("Action requires use of MSVC for either/both C or C++.");
  }

  return toolchainMap;
}

/**
 * Information on each compilation unit extracted from the CMake targets.
 * @param {object} group compilation data shared between one or more source files
 * @param {string} source absolute path to source file being compiled
 */
function CompileCommand(group, source) {
  // Filepath to source file being compiled
  this.source = source;
  // Compiler language used
  this.language = group.language;
  // C++ Standard
  this.standard = group.languageStandard ? group.languageStandard.standard : undefined;
  // Compile command line fragments appended into a single string
  this.args = (group.compileCommandFragments || []).map((c) => c.fragment).join(" ");
  // includes, both regular and system
  this.includes = (group.includes || []).map((inc) =>
    new IncludePath(inc.path, inc.isSystem || false));
  // defines
  this.defines = (group.defines || []).map((d) => d.define);
}

/**
 * Parse the codemodel-xxx.json and each target-xxx.json to find information on required to compile
 * each source file in the project.
 * @param {ReplyIndexInfo} replyIndexInfo ReplyIndexInfo info extracted from index-xxx.json reply
 * @returns CompileCommand information for each compiled source file in the project
 */
function loadCompileCommands(replyIndexInfo, buildConfiguration, excludedTargetPaths) {
  if (!existsSync(replyIndexInfo.codemodelResponseFile)) {
    throw new Error("Failed to load codemodel response from CMake API");
  }

  let compileCommands = [];
  const codemodel = parseReplyFile(replyIndexInfo.codemodelResponseFile);
  const sourceRoot = codemodel.paths.source;
  const replyDir = dirname(replyIndexInfo.codemodelResponseFile);
  let configurations = codemodel.configurations;
  if (configurations.length > 1) {
    if (!buildConfiguration) {
      throw new Error("buildConfiguration is required for multi-config CMake Generators.");
    }

    configurations = configurations.filter((config) => buildConfiguration == config.name);
    if (configurations.length == 0) {
      throw new Error("buildConfiguration does not match any available in CMake project.");
    }
  } else if (buildConfiguration && configurations[0].name != buildConfiguration) {
    throw new Error(`buildConfiguration does not match '${configurations[0].name}' configuration used by CMake.`);
  }

  const codemodelInfo = configurations[0];
  for (const targetInfo of codemodelInfo.targets) {
    const targetDir = join(sourceRoot, codemodelInfo.directories[targetInfo.directoryIndex].source);
    if (containsSubdirectory(excludedTargetPaths, targetDir)) {
      continue;
    }

    const target = parseReplyFile(join(replyDir, targetInfo.jsonFile));
    for (const group of target.compileGroups || []) {
      for (const sourceIndex of group.sourceIndexes) {
        const source = join(sourceRoot, target.sources[sourceIndex].path);
        compileCommands.push(new CompileCommand(group, source));
      }
    }
  }

  return compileCommands;
}

/**
 * Find path to  EspXEngine.dll as it only exists in host/target bin for MSVC Visual Studio release.
 * @param {ToolchainInfo} toolchain information on the toolchain being used
 * @returns absolute path to EspXEngine.dll
 */
function findEspXEngine(toolchain) {
  const hostDir = dirname(dirname(toolchain.path));
  const espXEnginePath = join(hostDir, toolchain.hostArch, 'EspXEngine.dll');
  if (existsSync(espXEnginePath)) {
    return espXEnginePath;
  }

  throw new Error(`Unable to find: ${espXEnginePath}`);
}

/**
 * Find official ruleset directory using the known path of MSVC compiler in Visual Studio.
 * @param {ToolchainInfo} toolchain information on the toolchain being used
 * @returns absolute path to directory containing all Visual Studio rulesets
 */
function findRulesetDirectory(toolchain) {
  const rulesetDirectory = getRelativeTo(toolchain.path, RelativeRulesetPath);
  return existsSync(rulesetDirectory) ? rulesetDirectory : undefined;
}

/**
 * Find ruleset first searching relative to GitHub repository and then relative to the official ruleset directory
 * shipped in Visual Studio.
 * @param {string} rulesetDirectory path to directory containing all Visual Studio rulesets
 * @returns path to ruleset found locally or inside Visual Studio
 */
function findRuleset(rulesetDirectory) {
  const repoRulesetPath = resolveInputPath("ruleset");
  if (!repoRulesetPath) {
    return undefined;
  } else if (existsSync(repoRulesetPath)) {
    info(`Found local ruleset: ${repoRulesetPath}`);
    return repoRulesetPath;
  }

  // search official ruleset directory that ships inside of Visual Studio
  const rulesetPath = getInput("ruleset");
  if (rulesetDirectory != undefined) {
    const officialRulesetPath = join(rulesetDirectory, rulesetPath);
    if (existsSync(officialRulesetPath)) {
      info(`Found official ruleset: ${officialRulesetPath}`);
      return officialRulesetPath;
    }
  } else {
    warning("Unable to find official rulesets shipped with Visual Studio.");
  }

  throw new Error(`Unable to find local or official ruleset specified: ${rulesetPath}`);
}

/**
 * Options to enable/disable different compiler features.
 */
function CompilerCommandOptions() {
  // Build configuration to use when using a multi-config CMake generator.
  this.buildConfiguration = getInput("buildConfiguration");
  // Use /external command line options to ignore warnings in CMake SYSTEM headers.
  this.ignoreSystemHeaders = getInput("ignoreSystemHeaders");
  // Toggle whether implicit includes/libs are loaded from Visual Studio Command Prompt
  this.loadImplicitCompilerEnv = getInput("loadImplicitCompilerEnv");
  // Ignore analysis on any CMake targets or includes.
  this.ignoredPaths = resolveInputPaths("ignoredPaths");
  this.ignoredTargetPaths = this.ignoredPaths || [];
  this.ignoredTargetPaths = this.ignoredTargetPaths.concat(resolveInputPaths("ignoredTargetPaths"));
  this.ignoredIncludePaths = this.ignoredPaths || [];
  this.ignoredIncludePaths = this.ignoredIncludePaths.concat(resolveInputPaths("ignoredIncludePaths"));
  // Additional arguments to add the command-line of every analysis instance
  this.additionalArgs = getInput("additionalArgs");
  // TODO: add support to build precompiled headers before running analysis.
  this.usePrecompiledHeaders = false; // core.getInput("usePrecompiledHeaders");
}

/**
 * Construct all command-line arguments that will be common among all sources files of a given compiler.
 * @param {*} toolchain information on the toolchain being used
 * @param {CompilerCommandOptions} options options for different compiler features
 * @returns list of analyze arguments common to the given toolchain
 */
function getCommonAnalyzeArguments(toolchain, options) {
  const args = ["/analyze:only", "/analyze:quiet", "/analyze:log:format:sarif", "/nologo"];

  const espXEngine = findEspXEngine(toolchain);
  args.push(`/analyze:plugin${espXEngine}`);

  const rulesetDirectory = findRulesetDirectory(toolchain);
  const rulesetPath = findRuleset(rulesetDirectory);
  if (rulesetPath != undefined) {
    args.push(`/analyze:ruleset${rulesetPath}`);

    // add ruleset directories incase user includes any official rulesets
    if (rulesetDirectory != undefined) {
      args.push(`/analyze:rulesetdirectory${rulesetDirectory}`);
    }
  } else {
    warning('Ruleset is not being used, all warnings will be enabled.');
  }

  if (options.ignoreSystemHeaders) {
    args.push(`/external:W0`);
    args.push(`/analyze:external-`);
  }

  if (options.additionalArgs) {
    args = args.concat(argStringToArray(options.additionalArgs));
  }

  return args;
}

/**
 * Extract the the implicit includes that should be used with the given compiler from the
 * Visual Studio command prompt corresponding with the toolchain used. This is required
 * as MSVC does not populate the CMake API `toolchain.implicit.includeDirectories` property.
 * @param {ToolchainInfo} toolchain information on the toolchain being used
 * @returns array of default includes used by the given MSVC toolset
 */
async function extractEnvironmentFromCommandPrompt(toolchain) {
  // use bat file to output environment variable required after running 'vcvarsall.bat' 
  const vcEnvScript = join(__dirname, "vc_env.bat");
  // init arguments for 'vcvarsall.bat' to match the toolset version/arch used
  const commandPromptPath = getRelativeTo(toolchain.path, RelativeCommandPromptPath);
  const arch = (toolchain.hostArch == toolchain.targetArch) ? 
    toolchain.hostArch : `${toolchain.hostArch}_${toolchain.targetArch}`;

  info("Extracting environment from VS Command Prompt");
  const execOptions = { silent: true };
  const execOutput = await getExecOutput(vcEnvScript,
    [commandPromptPath, arch, toolchain.toolsetVersion], execOptions);
  if (execOutput.exitCode != 0) {
    debug(execOutput.stdout);
    throw new Error("Failed to run VS Command Prompt to collect implicit includes/libs");
  }

  const env = { INCLUDE: "", LIB: "" };
  for (const line of execOutput.stdout.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index != -1) {
      const envVar = line.substring(0, index);
      if (envVar in env) {
        env[envVar] = line.substring(index + 1);
      }
    }
  }

  return env;
}

/**
 * Construct all environment variables that will be common among all sources files of a given compiler.
 * @param {ToolchainInfo} toolchain information on the toolchain being used
 * @param {CompilerCommandOptions} options options for different compiler features
 * @returns map of environment variables common to the given toolchain
 */
async function getCommonAnalyzeEnvironment(toolchain, options) {
  const env = {
    CAEmitSarifLog: "1", // enable compatibility mode as GitHub does not support some sarif options
    CAExcludePath: process.env.CAExcludePath || "",
    INCLUDE: process.env.INCLUDE || "",
    LIB: process.env.LIB || "",
  };

  if (options.loadImplicitCompilerEnv) {
    const commandPromptEnv = await extractEnvironmentFromCommandPrompt(toolchain);
    env.CAExcludePath += `;${commandPromptEnv.INCLUDE}`; // exclude all implicit includes
    env.INCLUDE += `;${commandPromptEnv.INCLUDE}`;
    env.LIB += `;${commandPromptEnv.LIB}`;
  }

  return env;
}

/**
 * Information required to run analysis on a single source file.
 * @param {string} source absolute path to the source file being compiled
 * @param {string} compiler absolute path to compiler used
 * @param {string[]} args all compilation and analyze arguments to pass to cl.exe
 * @param {[key: string]: string} env environment to use when running cl.exe
 * @param {string} sarifLog absolute path to SARIF log file that will be produced
 */
function AnalyzeCommand(source, compiler, args, env, sarifLog) {
  this.source = source;
  this.compiler = compiler;
  this.args = args;
  this.env = env;
  this.sarifLog = sarifLog;
}

/**
 * Load information needed to compile and analyze each source file in the given CMake project.
 * This makes use of the CMake file API and other sources to collect this data.
 * @param {string} buildRoot absolute path to the build directory of the CMake project
 * @param {CompilerCommandOptions} options options for different compiler features
 * @returns list of information to compile and analyze each source file in the project
 */
async function createAnalysisCommands(buildRoot, options) {
  const replyIndexInfo = await loadCMakeApiReplies(buildRoot);
  const toolchainMap = loadToolchainMap(replyIndexInfo);
  const compileCommands = loadCompileCommands(replyIndexInfo, options.buildConfiguration, options.ignoredTargetPaths);

  let commonArgsMap = {};
  let commonEnvMap = {};
  for (const toolchain of Object.values(toolchainMap)) {
    if (!(toolchain.path in commonArgsMap)) {
      commonArgsMap[toolchain.path] = getCommonAnalyzeArguments(toolchain, options);
      commonEnvMap[toolchain.path] = await getCommonAnalyzeEnvironment(toolchain, options);
    }
  }

  let analyzeCommands = []
  for (const command of compileCommands) {
    const toolchain = toolchainMap[command.language];
    if (toolchain) {
      let args = argStringToArray(command.args);
      const allIncludes = toolchain.includes.concat(command.includes);
      for (const include of allIncludes) {
        if ((options.ignoreSystemHeaders && include.isSystem) || 
            containsSubdirectory(options.ignoredIncludePaths, include.path)) {
          // TODO: filter compiler versions that don't support /external.
          args.push(`/external:I${include.path}`);
        } else {
          args.push(`/I${include.path}`);
        }
      }

      for (const define of command.defines) {
        args.push(`/D${define}`);
      }

      args.push(command.source);

      let sarifLog = null;
      try {
        sarifLog = fileSync({ postfix: '.sarif', discardDescriptor: true }).name;
      } catch (err) {
        // Clean up all temp SARIF logs
        analyzeCommands.forEach(command => unlinkSync(command.sarifLog));
        throw Error(`Failed to create temporary file to write SARIF: ${err}`, err);
      }
      
      args.push(`/analyze:log${sarifLog}`);

      args = args.concat(commonArgsMap[toolchain.path]);
      analyzeCommands.push(new AnalyzeCommand(
        command.source, toolchain.path, args, commonEnvMap[toolchain.path], sarifLog));
    }
  }

  return analyzeCommands;
}

// TODO: use a more performant data-structure such a hash-set
function ResultCache() {
  this.files = {};
  this.addIfUnique = function(sarifResult) {
    const id = sarifResult.ruleId;
    if (!id) {
      throw Error(`Found warning with no ID, resolve before continuing`);
    }

    const message = sarifResult.message ? sarifResult.message.text : undefined;
    if (!message) {
      throw Error(`Found warning with no message, resolve before continuing: ${id}`);
    }

    if (!sarifResult.locations || !sarifResult.locations[0] || !sarifResult.locations[0].physicalLocation) {
        throw Error(`Found warning with no location, resolve before continuing:\n${id}: ${message}`);
    }

    const physicalLocation = sarifResult.locations[0].physicalLocation;
    const file = physicalLocation.artifactLocation ? physicalLocation.artifactLocation.uri : undefined;
    const line = physicalLocation.region ? physicalLocation.region.startLine : undefined;
    const column = physicalLocation.region ? physicalLocation.region.startColumn : undefined;
    if (file == undefined || line == undefined || column == undefined) {
      throw Error(`Found warning with invalid location, resolve before continuing:\n${id}: ${message}`);
    }

    this.files[file] = this.files[file] || {};
    this.files[file][id] = this.files[file][id] || [];

    const ruleCache = this.files[file][id];
    if (ruleCache.some((result) => 
          result.line == line && result.column == column && result.message == message)) {
      return false;
    }

    ruleCache.push({
      line: line,
      column: column,
      message: message
    });

    return true;
  };
};

function combineSarif(resultPath, sarifFiles) {
  const resultCache = new ResultCache();
  const combinedSarif = {
    "version": "2.1.0",
    "$schema": "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0-rtm.5.json",
    "runs": [{
      "tool": null,
      "results": []
    }]
  };

  for (const sarifFile of sarifFiles) {
    const sarifLog = parseReplyFile(sarifFile);
    for (const run of sarifLog.runs) {
      if (!combinedSarif.runs[0].tool) {
        combinedSarif.runs[0].tool = run.tool;
      }

      for (const result of run.results) {
        if (resultCache.addIfUnique(result)) {
          combinedSarif.runs[0].results.push(result);
        }
      }
    }
  }

  try {
    writeFileSync(resultPath, JSON.stringify(combinedSarif), 'utf-8');
  } catch (err) {
    throw new Error("Failed to write combined SARIF result file.", err);
  }
}

/**
 * Main
 */
async function main() {
  var analyzeCommands = []; 
  try {
    const buildDir = resolveInputPath("cmakeBuildDirectory", true);
    if (!existsSync(buildDir)) {
      throw new Error("CMake build directory does not exist. Ensure CMake is already configured.");
    }

    let resultPath = resolveInputPath("resultsPath", false);
    if (!resultPath) {
      resultPath = join(buildDir, "results.sarif");
    } else if (!existsSync(dirname(resultPath))) {
      throw new Error("Directory of the 'resultPath' file must already exist.");
    }

    const options = new CompilerCommandOptions();
    analyzeCommands = await createAnalysisCommands(buildDir, options);
    if (analyzeCommands.length == 0) {
      throw new Error('No C/C++ files were found in the project that could be analyzed.');
    }

    // TODO: parallelism
    const failedSourceFiles = [];
    for (const command of analyzeCommands) {
      const execOptions = {
        cwd: buildDir,
        env: command.env,
      };

      // TODO: timeouts
      info(`Running analysis on: ${command.source}`);
      try {
        await _exec(`"${command.compiler}"`, command.args, execOptions);
      } catch (err) {
        debug(`Compilation failed with error: ${err}`);
        debug("Environment:");
        debug(execOptions.env);
        failedSourceFiles.push(command.source);
      }
    }

    if (failedSourceFiles.length > 0) {
      const fileList = failedSourceFiles
        .map(file => basename(file))
        .join(",");
      throw new Error(`Analysis failed due to compiler errors in files: ${fileList}`);
    }

    const sarifResults = analyzeCommands.map(command => command.sarifLog);
    combineSarif(resultPath, sarifResults);
    setOutput("sarif", resultPath);

  } catch (error) {
    if (isDebug()) {
      setFailed(error.stack)
    } else {
      setFailed(error)
    }
  } finally {
    analyzeCommands.map(command => command.sarifLog)
      .filter(log => existsSync(log))
      .forEach(log => unlinkSync(log));
  }
}

if (require.main === module) {
  (async () => {
    await main();
  })();
}