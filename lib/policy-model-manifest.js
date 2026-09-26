'use strict';

// Public, permissively licensed ONNX assets used by the local policy search.
// Every asset is pinned to an immutable Hugging Face revision and verified
// before inference. Runtime code never follows a mutable `main` branch.
module.exports = Object.freeze({
  manifestVersion: 1,
  embedding: Object.freeze({
    id: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    license: 'Apache-2.0',
    dimensions: 384,
    maxTokens: 256,
    files: Object.freeze([
      Object.freeze({
        name: 'embedding-model.onnx',
        remotePath: 'onnx/model_quantized.onnx',
        size: 22972370,
        sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1'
      }),
      Object.freeze({
        name: 'embedding-tokenizer.json',
        remotePath: 'tokenizer.json',
        size: 711661,
        sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'
      }),
      Object.freeze({
        name: 'embedding-tokenizer-config.json',
        remotePath: 'tokenizer_config.json',
        size: 366,
        sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'
      })
    ])
  }),
  reranker: Object.freeze({
    id: 'Xenova/ms-marco-MiniLM-L-6-v2',
    revision: 'a09144355adeed5f58c8ed011d209bf8ee5a1fec',
    license: 'Apache-2.0',
    maxTokens: 512,
    files: Object.freeze([
      Object.freeze({
        name: 'reranker-model.onnx',
        remotePath: 'onnx/model_quantized.onnx',
        size: 23143499,
        sha256: 'e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe'
      }),
      Object.freeze({
        name: 'reranker-tokenizer.json',
        remotePath: 'tokenizer.json',
        size: 711396,
        sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66'
      }),
      Object.freeze({
        name: 'reranker-tokenizer-config.json',
        remotePath: 'tokenizer_config.json',
        size: 1242,
        sha256: '0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53'
      })
    ])
  })
});
