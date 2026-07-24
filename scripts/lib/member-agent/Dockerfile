# Vanilla member-agent image for the docs/architecture.md §11 onboarding eval
# (Stage 5). NO Robot Money tooling is baked in here: no `rmpc` binary, no
# @robotmoney/contract or mcp/ source, no pre-registered MCP server, no
# onboarding knowledge of any kind. Only a generic OpenCode agent CLI plus the
# bare shell tools (curl/tar/git/jq) any of those would need to install `rmpc`
# and talk HTTP for itself — exactly what a real prospective member's own
# machine would have BEFORE following our docs. Everything Robot-Money-specific
# — installing rmpc, generating keys, building + signing the canonical
# application payload, submitting it — is something the agent inside the
# container must work out at runtime from the injected canonical prompt
# (contract's ONBOARDING_PROMPT, injected verbatim by
# scripts/lib/onboarding-eval.ts) plus the MCP `apply-how-to` tool and the
# linked skill. A failure to figure any of this out is a valid (red) eval
# result about our instructions, not a bug in this image.
#
# Pinned opencode release + checksum matches
# mcp/tests/opencode-tools/Dockerfile's own "agent" stage (already verified
# there) so both images trust the exact same real, released binary.
ARG OPENCODE_VERSION=1.18.1
ARG OPENCODE_LINUX_X64_SHA256=9ecce27cf529ade5f177fab478b4876b5c31d9ddc8216b994816acf192159511

FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar git jq bash \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION
ARG OPENCODE_LINUX_X64_SHA256
RUN curl -fsSLo /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
    && echo "${OPENCODE_LINUX_X64_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin \
    && rm /tmp/opencode.tar.gz

# rmpc is installed by the AGENT itself at runtime (the "toolchain" step of
# docs/architecture.md §11.2) via GitHub Releases egress — never by this image.
# A writable dir on PATH so the agent's own `curl | tar -C ... ` install lands
# somewhere it can execute rmpc from without root.
RUN mkdir -p /home/agent/.local/bin \
    && git config --global user.email "member-agent@robotmoney.invalid" \
    && git config --global user.name "member-agent" \
    && git init -q /home/agent
ENV PATH="/home/agent/.local/bin:${PATH}"
WORKDIR /home/agent

ENTRYPOINT ["opencode"]
