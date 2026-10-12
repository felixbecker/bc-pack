// @ts-check
// ESLint flat config for this UXP plugin.
//
// `premierepro.configs.recommended` enables Adobe's syntactic rules that catch
// the Premiere-specific mistakes which otherwise only surface at runtime:
//  - create*Action() outside lockedAccess()/executeTransaction()
//  - addAction() outside executeTransaction()
//  - async/await inside those callbacks
//  - Action objects escaping their lock scope

import premierepro from "@adobe/eslint-plugin-premierepro";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";

export default defineConfig(
    {
        ignores: ["node_modules/**"]
    },
    js.configs.recommended,
    premierepro.configs.recommended,
    {
        // Plugin sources are CommonJS (UXP uses require()). Scoped to *.js so
        // this config file itself stays an ES module.
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                require: "readonly",
                module: "writable",
                console: "readonly",
                document: "readonly",
                navigator: "readonly",
                setTimeout: "readonly"
            }
        }
    },
    {
        // Tests run in plain Node, not in UXP.
        files: ["test/**/*.js"],
        languageOptions: {
            globals: {
                __dirname: "readonly",
                process: "readonly"
            }
        }
    }
);
