FROM node:22-bookworm-slim AS node-runtime

FROM codercom/code-server:4.103.2

USER root

COPY --from=node-runtime /usr/local /usr/local

RUN npm install -g @openai/codex@0.116.0 \
  && mkdir -p /workspace /home/coder/.codex /home/coder/.local/share/code-server \
  && chown -R coder:coder /workspace /home/coder/.codex /home/coder/.local

COPY --chown=coder:coder deploy/code-server/start-code-server.sh /usr/local/bin/start-code-server.sh
RUN chmod +x /usr/local/bin/start-code-server.sh

USER coder

WORKDIR /workspace

CMD ["/usr/local/bin/start-code-server.sh"]
