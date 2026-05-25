require('dotenv').config();
const {
    Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
    ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder,
    ChannelType, PermissionFlagsBits, ButtonBuilder, ButtonStyle
} = require('discord.js');
const cron = require('cron');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const eventosAtivos = new Map();

const parseWeapons = (input) => {
    if (!input || input.toLowerCase() === '0' || input.toLowerCase() === 'nenhuma') return [];
    return input.split(',').map(s => s.trim()).filter(s => s !== '');
};

function getAvailableWeapons(requiredArray, participantsArray) {
    let available = [...requiredArray];
    participantsArray.forEach(p => {
        const idx = available.indexOf(p.arma);
        if (idx !== -1) available.splice(idx, 1);
    });
    return available;
}

function minutosAteHorario(horario) {
    if (!horario || !horario.includes(':')) return null;
    const [horaGrupo, minGrupo] = horario.split(':').map(Number);

    const formatter = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Recife',
        hour: '2-digit',
        minute: '2-digit'
    });
    const [horaAtualStr, minAtualStr] = formatter.format(new Date()).split(':');

    const minAtualTotal = parseInt(horaAtualStr) * 60 + parseInt(minAtualStr);
    const minGrupoTotal = horaGrupo * 60 + minGrupo;

    let diferenca = minGrupoTotal - minAtualTotal;
    if (diferenca < 0) diferenca += 1440;

    return diferenca;
}

async function abrirSalaGrupo(guild, evento, indexGrupo) {
    const grupo = evento.grupos[indexGrupo];

    if (grupo.canalVozId) {
        const existente = guild.channels.cache.get(grupo.canalVozId);
        if (existente) return existente;
        grupo.canalVozId = null;
    }

    const permissionOverwrites = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }
    ];

    for (const participante of grupo.participantes) {
        permissionOverwrites.push({
            id: participante.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
        });
    }

    const categoriaValida = evento.categoriaId
        && guild.channels.cache.get(evento.categoriaId)
        && guild.channels.cache.get(evento.categoriaId).type === ChannelType.GuildCategory;

    const canal = await guild.channels.create({
        name: `Sala Grupo ${indexGrupo + 1} - ${evento.nome}`,
        type: ChannelType.GuildVoice,
        parent: categoriaValida ? evento.categoriaId : undefined,
        permissionOverwrites
    });

    grupo.canalVozId = canal.id;
    return canal;
}

async function fecharSalaGrupoSeVazia(guild, evento, indexGrupo) {
    const grupo = evento.grupos[indexGrupo];
    if (!grupo || !grupo.canalVozId) return;

    const canal = guild.channels.cache.get(grupo.canalVozId);
    if (!canal) {
        grupo.canalVozId = null;
        return;
    }

    if (canal.members.size === 0) {
        await canal.delete('Sala fechada automaticamente: sem membros no canal.');
        grupo.canalVozId = null;
    }
}

const comandoEvento = new SlashCommandBuilder()
    .setName('evento')
    .setDescription('Cria evento com envio de DM e salas por grupo')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('nome').setDescription('Nome da Raid/Evento').setRequired(true))
    .addUserOption(opt => opt.setName('lider').setDescription('Líder do evento').setRequired(true))
    .addStringOption(opt => opt.setName('horarios').setDescription('Ex: 13:00, 14:00...').setRequired(true))
    .addChannelOption(opt =>
        opt
            .setName('categoria')
            .setDescription('Categoria onde as salas de voz dos grupos serão abertas')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false)
    )
    .addStringOption(opt => opt.setName('armas_tank').setDescription('Ex: Maça, Martelo').setRequired(false))
    .addStringOption(opt => opt.setName('armas_healer').setDescription('Ex: Sagrado, Natureza').setRequired(false))
    .addStringOption(opt => opt.setName('armas_suporte').setDescription('Ex: Chama-sombra').setRequired(false))
    .addStringOption(opt => opt.setName('armas_dps').setDescription('Ex: Espada, Machado').setRequired(false))
    .addStringOption(opt => opt.setName('armas_ranger').setDescription('Ex: Arco, Cajado').setRequired(false));

function gerarInterface(evento) {
    const embed = new EmbedBuilder()
        .setTitle(`⚔️ EVENTO: ${evento.nome.toUpperCase()}`)
        .setColor('#e67e22')
        .setDescription(`👑 **Líder:** <@${evento.lider}>\n👥 **Capacidade Máxima:** ${evento.totalVagas} jogadores por grupo\n\n*Selecione o bloco do seu horário no menu abaixo para entrar.*`);

    evento.grupos.forEach((g, i) => {
        let desc = '';

        const gerarLinha = (roleKey, emoji, label) => {
            const exigidas = evento.composicao[roleKey];
            if (exigidas.length === 0) return '';

            const membros = g.participantes.filter(m => m.role === roleKey);
            const livres = getAvailableWeapons(exigidas, membros);
            const textoMembros = membros.map(m => `<@${m.id}> [${m.arma}]`).join(', ') || '---';

            let linha = `${emoji} **${label} (${membros.length}/${exigidas.length})**\n> 👤 ${textoMembros}\n`;

            if (livres.length > 0) {
                linha += `> 🟢 *Livres:* \`${livres.join(' | ')}\`\n\n`;
            } else {
                linha += `> 🔴 *Lotação máxima!*\n\n`;
            }
            return linha;
        };

        desc += gerarLinha('TANK', '🛡️', 'TANK');
        desc += gerarLinha('HEALER', '💚', 'HEALER');
        desc += gerarLinha('SUPORTE', '🔮', 'SUPORTE');
        desc += gerarLinha('DPS', '⚔️', 'DPS MELEE');
        desc += gerarLinha('DPS RANGER', '🏹', 'DPS RANGER');

        if (!desc) desc = '> *Nenhuma classe foi configurada para este evento.*\n';
        desc += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        embed.addFields({
            name: `🔹 BLOCO ${i + 1} — 🕒 HORÁRIO: ${g.horario} (${g.participantes.length}/${evento.totalVagas})`,
            value: desc,
            inline: false
        });
    });

    const menuGrupos = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`select_group_${evento.id}`)
            .setPlaceholder('Selecione o Grupo/Horário que deseja entrar...')
            .addOptions(evento.grupos.map((g, i) => ({
                label: `Grupo ${i + 1} - Horário: ${g.horario}`,
                description: `Vagas: ${g.participantes.length}/${evento.totalVagas}`,
                value: `${i}`
            })))
    );

    const botaoSair = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`leave_all_${evento.id}`).setLabel('Sair de Todos os Grupos').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [menuGrupos, botaoSair] };
}

function gerarMenuRoles(idEvento, indexGrupo) {
    const evento = eventosAtivos.get(idEvento);
    const grupo = evento.grupos[indexGrupo];
    const options = [];

    const verificarVaga = (label, roleKey) => {
        const exigidas = evento.composicao[roleKey];
        if (exigidas.length === 0) return;
        const membros = grupo.participantes.filter(p => p.role === roleKey);
        if (membros.length < exigidas.length) options.push({ label: label, value: roleKey });
    };

    verificarVaga('🛡️ Tank', 'TANK');
    verificarVaga('💚 Healer', 'HEALER');
    verificarVaga('🔮 Suporte', 'SUPORTE');
    verificarVaga('⚔️ DPS Melee', 'DPS');
    verificarVaga('🏹 DPS Ranger', 'DPS RANGER');

    if (options.length === 0) options.push({ label: 'Grupo Totalmente Lotado', value: 'FULL' });

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`select_role_${idEvento}_${indexGrupo}`).setPlaceholder('Escolha sua função...').addOptions(options)
    );
}

function gerarMenuArmas(idEvento, indexGrupo, role) {
    const evento = eventosAtivos.get(idEvento);
    const grupo = evento.grupos[indexGrupo];
    const disponiveis = getAvailableWeapons(evento.composicao[role], grupo.participantes.filter(p => p.role === role));

    const contagem = {};
    disponiveis.forEach(arma => contagem[arma] = (contagem[arma] || 0) + 1);

    const options = Object.keys(contagem).map(arma => ({
        label: `${arma} (${contagem[arma]} vaga${contagem[arma] > 1 ? 's' : ''})`,
        value: arma
    }));

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`select_weapon_${idEvento}_${indexGrupo}_${role}`).setPlaceholder('Escolha sua arma...').addOptions(options)
    );
}

client.once('ready', async () => {
    console.log(`🤖 Bot online como ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [comandoEvento.toJSON()] });
        console.log('✅ Comando /evento com salas por grupo e notificações ativado!');
    } catch (error) {
        console.error('Erro ao registrar comando:', error);
    }

    // A cada minuto: abre sala 30 minutos antes e dispara DM para inscritos.
    new cron.CronJob('* * * * *', async () => {
        for (const [idEvento, evento] of eventosAtivos) {
            const guild = client.guilds.cache.get(evento.guildId);
            if (!guild) continue;

            for (let i = 0; i < evento.grupos.length; i++) {
                const grupo = evento.grupos[i];
                const diferenca = minutosAteHorario(grupo.horario);
                if (diferenca === null) continue;

                if (diferenca === 30) {
                    if (!grupo.canalVozId) {
                        try {
                            await abrirSalaGrupo(guild, evento, i);
                        } catch (err) {
                            console.error(`Erro ao abrir sala do Grupo ${i + 1}:`, err);
                        }
                    }

                    if (!grupo.notificado) {
                        grupo.notificado = true;
                        for (const participante of grupo.participantes) {
                            try {
                                const user = await client.users.fetch(participante.id);
                                await user.send(`⏳ **Atenção!** O seu grupo para o evento **${evento.nome}** (Horário: ${grupo.horario}) começa em **30 minutos**! A sala de voz do grupo já foi aberta no servidor.`);
                            } catch (err) {
                                console.log(`Não foi possível enviar DM para o usuário ${participante.id} (DMs fechadas).`);
                            }
                        }
                    }
                }
            }
        }
    }).start();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.channelId === newState.channelId || !oldState.channelId) return;

    for (const [, evento] of eventosAtivos) {
        if (evento.guildId !== oldState.guild.id) continue;
        for (let i = 0; i < evento.grupos.length; i++) {
            if (evento.grupos[i].canalVozId === oldState.channelId) {
                try {
                    await fecharSalaGrupoSeVazia(oldState.guild, evento, i);
                } catch (err) {
                    console.error(`Erro ao fechar sala do Grupo ${i + 1}:`, err);
                }
            }
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isCommand() && interaction.commandName === 'evento') {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Apenas administradores podem criar eventos.', ephemeral: true });
        }

        const idEvento = Date.now().toString();
        const nome = interaction.options.getString('nome');
        const lider = interaction.options.getUser('lider');
        const categoria = interaction.options.getChannel('categoria');

        const horariosRaw = interaction.options.getString('horarios').split(',').map(h => h.trim()).filter(h => h !== '');

        const composicao = {
            'TANK': parseWeapons(interaction.options.getString('armas_tank')),
            'HEALER': parseWeapons(interaction.options.getString('armas_healer')),
            'SUPORTE': parseWeapons(interaction.options.getString('armas_suporte')),
            'DPS': parseWeapons(interaction.options.getString('armas_dps')),
            'DPS RANGER': parseWeapons(interaction.options.getString('armas_ranger'))
        };

        const totalVagas = Object.values(composicao).reduce((acc, arr) => acc + arr.length, 0);

        if (totalVagas === 0) return interaction.reply({ content: '❌ Defina pelo menos uma arma!', ephemeral: true });
        if (horariosRaw.length === 0) return interaction.reply({ content: '❌ Informe 1 horário!', ephemeral: true });

        await interaction.deferReply();

        const numGrupos = Math.min(horariosRaw.length, 10);
        const grupos = [];
        for (let i = 0; i < numGrupos; i++) {
            grupos.push({ horario: horariosRaw[i], participantes: [], notificado: false, canalVozId: null });
        }

        const categoriaIdPadrao = interaction.channel && interaction.channel.parentId ? interaction.channel.parentId : null;

        const novoEvento = {
            id: idEvento,
            nome,
            lider: lider.id,
            guildId: interaction.guild.id,
            categoriaId: categoria ? categoria.id : categoriaIdPadrao,
            composicao,
            totalVagas,
            grupos
        };

        eventosAtivos.set(idEvento, novoEvento);
        await interaction.editReply(gerarInterface(novoEvento));
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_group_')) {
        const idEvento = interaction.customId.split('_')[2];
        const indexGrupo = interaction.values[0];
        await interaction.reply({ content: `Você escolheu o **Grupo ${parseInt(indexGrupo) + 1}**. Agora selecione sua classe:`, components: [gerarMenuRoles(idEvento, indexGrupo)], ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_role_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const role = interaction.values[0];
        if (role === 'FULL') return interaction.update({ content: '❌ Este grupo já está totalmente lotado.', components: [] });

        const evento = eventosAtivos.get(idEvento);
        const usuario = interaction.user.id;

        if (!evento) return interaction.update({ content: 'Este evento não está mais ativo.', components: [] });

        let jaEsta = false;
        evento.grupos.forEach(g => { if (g.participantes.find(p => p.id === usuario)) jaEsta = true; });
        if (jaEsta) return interaction.update({ content: '❌ Você já está registrado! Saia primeiro para trocar.', components: [] });

        await interaction.update({ content: `Você escolheu **${role}**. Pegue uma das armas:`, components: [gerarMenuArmas(idEvento, indexGrupo, role)] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_weapon_')) {
        const partes = interaction.customId.split('_');
        const idEvento = partes[2];
        const indexGrupo = parseInt(partes[3], 10);
        const role = partes.slice(4).join('_');
        const arma = interaction.values[0];

        const evento = eventosAtivos.get(idEvento);
        const usuario = interaction.user.id;

        if (!evento) return interaction.update({ content: 'Este evento não está mais ativo.', components: [] });

        const grupo = evento.grupos[indexGrupo];
        const disponiveis = getAvailableWeapons(evento.composicao[role], grupo.participantes.filter(p => p.role === role));

        if (!disponiveis.includes(arma)) return interaction.update({ content: '❌ Tarde demais! Vaga preenchida.', components: [] });

        grupo.participantes.push({ id: usuario, role, arma });

        if (grupo.canalVozId) {
            const canal = interaction.guild.channels.cache.get(grupo.canalVozId);
            if (canal) {
                await canal.permissionOverwrites.create(usuario, {
                    ViewChannel: true,
                    Connect: true
                });
            }
        }

        const msgPrincipal = await interaction.channel.messages.fetch(interaction.message.reference.messageId);
        await msgPrincipal.edit(gerarInterface(evento));

        await interaction.update({ content: `✅ Registrado no **Grupo ${indexGrupo + 1}** de **${role} [${arma}]**!`, components: [] });
    }

    if (interaction.isButton() && interaction.customId.startsWith('leave_all_')) {
        const idEvento = interaction.customId.split('_')[2];
        const evento = eventosAtivos.get(idEvento);
        const usuario = interaction.user.id;

        if (evento) {
            for (const [index, grupo] of evento.grupos.entries()) {
                grupo.participantes = grupo.participantes.filter(p => p.id !== usuario);
                if (grupo.canalVozId) {
                    const canal = interaction.guild.channels.cache.get(grupo.canalVozId);
                    if (canal) {
                        await canal.permissionOverwrites.delete(usuario).catch(() => null);
                        await fecharSalaGrupoSeVazia(interaction.guild, evento, index);
                    }
                }
            }
            await interaction.update(gerarInterface(evento));
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
