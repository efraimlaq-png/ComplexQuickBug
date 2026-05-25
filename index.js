require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, 
    ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, 
    ChannelType, PermissionFlagsBits, ButtonBuilder, ButtonStyle
} = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const eventosAtivos = new Map();

// Função auxiliar para transformar o texto em uma lista de armas
const parseWeapons = (input) => {
    if (!input || input.toLowerCase() === '0' || input.toLowerCase() === 'nenhuma') return [];
    return input.split(',').map(s => s.trim()).filter(s => s !== '');
};

// Função auxiliar para saber quais armas ainda estão livres
function getAvailableWeapons(requiredArray, participantsArray) {
    let available = [...requiredArray];
    participantsArray.forEach(p => {
        const idx = available.indexOf(p.arma);
        if (idx !== -1) available.splice(idx, 1);
    });
    return available;
}

const comandoEvento = new SlashCommandBuilder()
    .setName('evento')
    .setDescription('Cria um evento de Albion com vagas baseadas em armas específicas')
    .addStringOption(opt => opt.setName('nome').setDescription('Nome da Raid/Evento').setRequired(true))
    .addUserOption(opt => opt.setName('lider').setDescription('Líder do evento').setRequired(true))
    .addStringOption(opt => opt.setName('horarios').setDescription('Ex: 13:00, 14:00... (Cria os grupos automaticamente)').setRequired(true))
    .addStringOption(opt => opt.setName('armas_tank').setDescription('Ex: Maça, Martelo (Deixe em branco se 0)').setRequired(false))
    .addStringOption(opt => opt.setName('armas_healer').setDescription('Ex: Sagrado, Natureza (Deixe em branco se 0)').setRequired(false))
    .addStringOption(opt => opt.setName('armas_suporte').setDescription('Ex: Chama-sombra, Arcano (Deixe em branco se 0)').setRequired(false))
    .addStringOption(opt => opt.setName('armas_dps').setDescription('Ex: Espada, Machado, Adaga (Deixe em branco se 0)').setRequired(false))
    .addStringOption(opt => opt.setName('armas_ranger').setDescription('Ex: Arco, Cajado de Fogo (Deixe em branco se 0)').setRequired(false));

function gerarInterface(evento) {
    const embed = new EmbedBuilder()
        .setTitle(`⚔️ EVENTO: ${evento.nome.toUpperCase()}`)
        .setColor('#e67e22')
        .setDescription(`👑 **Líder:** <@${evento.lider}>\n👥 **Capacidade Máxima:** ${evento.totalVagas} jogadores por grupo\n\n*Selecione o bloco do seu horário no menu abaixo para entrar.*`);

    // Geração dos Blocos de Grupo Formatados
    evento.grupos.forEach((g, i) => {
        let desc = '';
        
        const gerarLinha = (roleKey, emoji, label) => {
            const exigidas = evento.composicao[roleKey];
            if (exigidas.length === 0) return ''; 
            
            const membros = g.participantes.filter(m => m.role === roleKey);
            const livres = getAvailableWeapons(exigidas, membros);
            const textoMembros = membros.map(m => `<@${m.id}> [${m.arma}]`).join(', ') || '---';
            
            // Design em Bloco com Citação (>)
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

        if (!desc) desc = "> *Nenhuma classe foi configurada para este evento.*\n";

        // Linha divisória robusta no final do bloco
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
                description: `Vagas preenchidas: ${g.participantes.length}/${evento.totalVagas}`,
                value: `${i}`
            })))
    );

    const botaoSair = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`leave_all_${evento.id}`).setLabel('Sair de Todos os Grupos').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [menuGrupos, botaoSair] };
}

// Menu de Roles Dinâmico (Só mostra o que ainda tem vaga)
function gerarMenuRoles(idEvento, indexGrupo) {
    const evento = eventosAtivos.get(idEvento);
    const grupo = evento.grupos[indexGrupo];
    const options = [];

    const verificarVaga = (label, roleKey) => {
        const exigidas = evento.composicao[roleKey];
        if (exigidas.length === 0) return; 
        
        const membros = grupo.participantes.filter(p => p.role === roleKey);
        if (membros.length < exigidas.length) {
            options.push({ label: label, value: roleKey });
        }
    };

    verificarVaga('🛡️ Tank', 'TANK');
    verificarVaga('💚 Healer', 'HEALER');
    verificarVaga('🔮 Suporte', 'SUPORTE');
    verificarVaga('⚔️ DPS Melee', 'DPS');
    verificarVaga('🏹 DPS Ranger', 'DPS RANGER');

    if (options.length === 0) options.push({ label: 'Grupo Totalmente Lotado', value: 'FULL' });

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`select_role_${idEvento}_${indexGrupo}`)
            .setPlaceholder('Escolha sua função (Role)...')
            .addOptions(options)
    );
}

// Menu de Armas Dinâmico (Lê as armas restantes)
function gerarMenuArmas(idEvento, indexGrupo, role) {
    const evento = eventosAtivos.get(idEvento);
    const grupo = evento.grupos[indexGrupo];
    
    const exigidas = evento.composicao[role];
    const membros = grupo.participantes.filter(p => p.role === role);
    const disponiveis = getAvailableWeapons(exigidas, membros);

    const contagem = {};
    disponiveis.forEach(arma => contagem[arma] = (contagem[arma] || 0) + 1);

    const options = Object.keys(contagem).map(arma => ({
        label: `${arma} (${contagem[arma]} vaga${contagem[arma] > 1 ? 's' : ''})`,
        value: arma
    }));

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`select_weapon_${idEvento}_${indexGrupo}_${role}`)
            .setPlaceholder(`Escolha sua arma para ${role}...`)
            .addOptions(options)
    );
}

client.once('ready', async () => {
    console.log(`🤖 Bot online como ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [comandoEvento.toJSON()] });
        console.log('✅ Comando /evento atualizado com Design de Blocos!');
    } catch (error) {
        console.error('Erro ao registrar comando:', error);
    }
});

client.on('interactionCreate', async interaction => {
    
    // 1. CRIAÇÃO DO EVENTO
    if (interaction.isCommand() && interaction.commandName === 'evento') {
        const idEvento = Date.now().toString();
        const nome = interaction.options.getString('nome');
        const lider = interaction.options.getUser('lider');
        
        // Pega os horários, limpa os espaços em branco e filtra vazios
        const horariosRaw = interaction.options.getString('horarios')
            .split(',')
            .map(h => h.trim())
            .filter(h => h !== '');

        const composicao = {
            'TANK': parseWeapons(interaction.options.getString('armas_tank')),
            'HEALER': parseWeapons(interaction.options.getString('armas_healer')),
            'SUPORTE': parseWeapons(interaction.options.getString('armas_suporte')),
            'DPS': parseWeapons(interaction.options.getString('armas_dps')),
            'DPS RANGER': parseWeapons(interaction.options.getString('armas_ranger'))
        };
        
        const totalVagas = Object.values(composicao).reduce((acc, arr) => acc + arr.length, 0);

        if (totalVagas === 0) {
            return interaction.reply({ content: '❌ Você precisa definir as armas de pelo menos uma função para abrir o evento!', ephemeral: true });
        }
        if (horariosRaw.length === 0) {
            return interaction.reply({ content: '❌ Você precisa informar pelo menos 1 horário!', ephemeral: true });
        }

        await interaction.deferReply();

        // GERAÇÃO DINÂMICA: Cria APENAS a quantidade de grupos baseada nos horários informados (Máx 10)
        const numGrupos = Math.min(horariosRaw.length, 10);
        const grupos = [];
        for (let i = 0; i < numGrupos; i++) {
            grupos.push({ horario: horariosRaw[i], participantes: [] });
        }

        const canalVoz = await interaction.guild.channels.create({
            name: `🎧 ${nome}`,
            type: ChannelType.GuildVoice,
            permissionOverwrites: [{ id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] }],
        });

        const novoEvento = { id: idEvento, nome, lider: lider.id, composicao, totalVagas, canalVozId: canalVoz.id, grupos };
        eventosAtivos.set(idEvento, novoEvento);

        await interaction.editReply(gerarInterface(novoEvento));
    }

    // 2. SELEÇÃO DE GRUPO
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_group_')) {
        const idEvento = interaction.customId.split('_')[2];
        const indexGrupo = interaction.values[0];
        
        await interaction.reply({ 
            content: `Você escolheu o **Grupo ${parseInt(indexGrupo)+1}**. Agora selecione sua classe:`, 
            components: [gerarMenuRoles(idEvento, indexGrupo)],
            ephemeral: true 
        });
    }

    // 3. SELEÇÃO DE CLASSE
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_role_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const role = interaction.values[0];
        if (role === 'FULL') return interaction.update({ content: '❌ Este grupo já está totalmente lotado.', components: [] });

        const evento = eventosAtivos.get(idEvento);
        const usuario = interaction.user.id;

        if (!evento) return interaction.update({ content: 'Este evento não está mais ativo.', components: [] });

        let jaEsta = false;
        evento.grupos.forEach(g => { if(g.participantes.find(p => p.id === usuario)) jaEsta = true; });
        if (jaEsta) return interaction.update({ content: '❌ Você já está registrado! Saia primeiro para trocar.', components: [] });

        await interaction.update({ 
            content: `Você escolheu a classe **${role}**. Agora pegue uma das armas disponíveis:`, 
            components: [gerarMenuArmas(idEvento, indexGrupo, role)] 
        });
    }

    // 4. SELEÇÃO DE ARMA
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_weapon_')) {
        const partes = interaction.customId.split('_');
        const idEvento = partes[2];
        const indexGrupo = partes[3];
        const role = partes[4];
        const arma = interaction.values[0];
        
        const evento = eventosAtivos.get(idEvento);
        const usuario = interaction.user.id;

        if (!evento) return interaction.update({ content: 'Este evento não está mais ativo.', components: [] });

        const grupo = evento.grupos[indexGrupo];
        
        const disponiveis = getAvailableWeapons(evento.composicao[role], grupo.participantes.filter(p => p.role === role));
        if (!disponiveis.includes(arma)) {
            return interaction.update({ content: `❌ Tarde demais! A vaga para **${arma}** acabou de ser preenchida. Tente outra.`, components: [] });
        }

        grupo.participantes.push({ id: usuario, role, arma });
        
        const canal = interaction.guild.channels.cache.get(evento.canalVozId);
        if (canal) await canal.permissionOverwrites.create(usuario, { ViewChannel: true, Connect: true });

        const msgPrincipal = await interaction.channel.messages.fetch(interaction.message.reference.messageId);
        await msgPrincipal.edit(gerarInterface(evento));

        await interaction.update({ content: `✅ Registrado no **Grupo ${parseInt(indexGrupo)+1}** de **${role} [${arma}]**!`, components: [] });
    }

    // 5. SAIR DO EVENTO
    if (interaction.isButton() && interaction.customId.startsWith('leave_all_')) {
        const idEvento = interaction.customId.split('_')[2];
        const evento = eventosAtivos.get(idEvento);
        const usuario = interaction.user.id;

        if (evento) {
            evento.grupos.forEach(g => { g.participantes = g.participantes.filter(p => p.id !== usuario); });
            const canal = interaction.guild.channels.cache.get(evento.canalVozId);
            if (canal) await canal.permissionOverwrites.delete(usuario);
            await interaction.update(gerarInterface(evento));
        }
    }
});

client.login(process.env.DISCORD_TOKEN);